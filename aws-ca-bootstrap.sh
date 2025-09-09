#!/bin/bash
#
# This script will get an SSH host certificate from our CA and add a weekly
# cron job to rotate the host certificate. It should be run as root.
# 
# See https://smallstep.com/blog/diy-single-sign-on-for-ssh/ for full instructions

CA_URL="https://ec2-35-175-175-251.compute-1.amazonaws.com"

# Obtain your CA fingerprint by running this on your CA:
#   # step certificate fingerprint $(step path)/certs/root_ca.crt
CA_FINGERPRINT="b3f190faa998fc479437c0fd5d0c8e9d6b99541e0792c82e12cd89dda8fc8e63"

case $(arch) in
x86_64)
    ARCH="amd64"
    ;;
aarch64)
    ARCH="arm64"
    ;;
esac

# Install step
STEP_VERSION=$(curl -s https://api.github.com/repos/smallstep/cli/releases/latest | jq -r '.tag_name')

curl -sLO https://github.com/smallstep/cli/releases/download/${STEP_VERSION}/step-cli_${STEP_VERSION:1}_${ARCH}.deb
dpkg -i step-cli_${STEP_VERSION:1}_${ARCH}.deb

# Configure `step` to connect to & trust our `step-ca`.
# Pull down the CA's root certificate so we can talk to it later with TLS
step ca bootstrap --ca-url $CA_URL \
                  --fingerprint $CA_FINGERPRINT

# Install the CA cert for validating user certificates (from /etc/step-ca/certs/ssh_user_key.pub` on the CA).
step ssh config --roots > $(step path)/certs/ssh_user_key.pub

# Get AWS host metadata (IMDSv2)
AWS_TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

LOCAL_HOSTNAME=$(curl -H "X-aws-ec2-metadata-token: $AWS_TOKEN" -s http://169.254.169.254/latest/meta-data/local-hostname)
LOCAL_IP=$(curl -H "X-aws-ec2-metadata-token: $AWS_TOKEN" -s http://169.254.169.254/latest/meta-data/local-ipv4)
PUBLIC_HOSTNAME=$(curl -H "X-aws-ec2-metadata-token: $AWS_TOKEN" -s http://169.254.169.254/latest/meta-data/public-hostname)
PUBLIC_IP=$(curl -H "X-aws-ec2-metadata-token: $AWS_TOKEN" -s http://169.254.169.254/latest/meta-data/public-ipv4)
AWS_ACCOUNT_ID=$(curl -H "X-aws-ec2-metadata-token: $AWS_TOKEN" -s http://169.254.169.254/latest/dynamic/instance-identity/document | grep accountId | awk '{print $3}' | sed 's/"//g' | sed 's/,//g')

# Get an SSH host certificate

# This helps us avoid a potential race condition / clock skew issue
# "x509: certificate has expired or is not yet valid: current time 2020-04-01T17:52:51Z is before 2020-04-01T17:52:52Z"
sleep 1

# The TOKEN is a JWT with the instance identity document and signature embedded in it.
TOKEN=$(step ca token $PUBLIC_HOSTNAME --ssh --host --provisioner "Amazon Web Services")

# To inspect $TOKEN, run
# $ echo $TOKEN | step crypto jwt inspect --insecure
#
# To inspect the Instance Identity Document embedded in the token, run
# $ echo $TOKEN | step crypto jwt inspect --insecure | jq -r ".payload.amazon.document" | base64 -d

# Ask the CA to exchange our instance token for an SSH host certificate
step ssh certificate $PUBLIC_HOSTNAME /etc/ssh/ssh_host_ecdsa_key.pub \
    --host --sign --provisioner "Amazon Web Services" \
    --principal $PUBLIC_HOSTNAME --principal $LOCAL_HOSTNAME \
    --token $TOKEN

# Configure and restart `sshd`
tee -a /etc/ssh/sshd_config > /dev/null <<EOF
# SSH CA Configuration

# This is the CA's public key, for authenticatin user certificates:
TrustedUserCAKeys $(step path)/certs/ssh_user_key.pub

# This is our host private key and certificate:
HostKey /etc/ssh/ssh_host_ecdsa_key
HostCertificate /etc/ssh/ssh_host_ecdsa_key-cert.pub
EOF

service ssh restart

# Now add a weekly cron script to rotate our host certificate.
cat <<EOF > /etc/cron.weekly/rotate-ssh-certificate
#!/bin/sh

export STEPPATH=/root/.step

cd /etc/ssh && step ssh renew ssh_host_ecdsa_key-cert.pub ssh_host_ecdsa_key --force 2> /dev/null

exit 0
EOF

chmod 755 /etc/cron.weekly/rotate-ssh-certificate
