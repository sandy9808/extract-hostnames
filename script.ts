import * as https from 'https';
import * as http from 'http';

interface SiteHostnameInfo {
  sitePath: string;
  hostnames: string[];
  bmNodeFiles: string[];
  errors: string[];
}

interface HostnameExtractor {
  extractHostnamesFromGiteaRepository(baseUrl: string, branch?: string): Promise<Map<string, SiteHostnameInfo>>;
}

class BMNodeHostnameExtractor implements HostnameExtractor {
  // Regex to match bm-node files
  private readonly bmNodeFileRegex = /bm-node-.+\.yaml$/;
  
  // Regex to extract hostname from the bmac.agent-install.openshift.io/hostname annotation
  private readonly hostnameRegex = /bmac\.agent-install\.openshift\.io\/hostname:\s*["']?([^"'\s]+)["']?/;

  /**
   * Creates an insecure HTTPS agent that ignores certificate errors
   */
  private createInsecureAgent(): https.Agent {
    return new https.Agent({
      rejectUnauthorized: false, // Ignore SSL certificate errors
      timeout: 15000 // 15 second timeout
    });
  }

  /**
   * Fetches content from a URL with insecure HTTPS
   * @param url - URL to fetch
   * @returns Promise that resolves to the response body
   */
  private fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https://');
      const client = isHttps ? https : http;
      
      const options = isHttps ? {
        agent: this.createInsecureAgent()
      } : {};

      const request = client.get(url, options, (response) => {
        let data = '';

        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          if (response.headers.location) {
            return this.fetchUrl(response.headers.location)
              .then(resolve)
              .catch(reject);
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage} for ${url}`));
          return;
        }

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          resolve(data);
        });
      });

      request.on('error', (error) => {
        reject(new Error(`Request failed for ${url}: ${error.message}`));
      });

      request.setTimeout(15000, () => {
        request.destroy();
        reject(new Error(`Request timeout for ${url}`));
      });
    });
  }

  /**
   * Converts repository URL to Gitea directory API URL
   * @param repoUrl - Repository URL (e.g., https://codehub.jio.indradhanus.com/indradhanus/sites)
   * @param path - Path within the repository (optional)
   * @param branch - Branch name (default: 'dev')
   * @returns API URL for directory listing
   */
  private convertToGiteaApiUrl(repoUrl: string, path: string = '', branch: string = 'dev'): string {
    // Extract parts from repo URL
    const urlParts = repoUrl.replace(/\/$/, '').split('/');
    const baseUrl = urlParts.slice(0, -2).join('/'); // Everything except owner/repo
    const owner = urlParts[urlParts.length - 2];
    const repo = urlParts[urlParts.length - 1];

    const pathSegment = path ? `/${path}` : '';
    return `${baseUrl}/api/v1/repos/${owner}/${repo}/contents${pathSegment}?ref=${branch}`;
  }

  /**
   * Gets directory listing from Gitea API
   * @param repoUrl - Repository URL
   * @param path - Path within the repository
   * @param branch - Branch name
   * @returns Promise that resolves to array of file/directory information
   */
  private async getGiteaDirectoryListing(repoUrl: string, path: string = '', branch: string = 'dev'): Promise<any[]> {
    try {
      const apiUrl = this.convertToGiteaApiUrl(repoUrl, path, branch);
      
      const response = await this.fetchUrl(apiUrl);
      const items = JSON.parse(response);
      
      if (!Array.isArray(items)) {
        throw new Error('Unexpected response format from Gitea API');
      }

      return items;
    } catch (error) {
      return [];
    }
  }

  /**
   * Determines if a directory path represents a "site" (contains bm-node files)
   * @param items - Directory items
   * @returns True if directory contains bm-node files
   */
  private isSiteDirectory(items: any[]): boolean {
    return items.some(item => 
      item.type === 'file' && 
      item.name && 
      this.bmNodeFileRegex.test(item.name)
    );
  }

  /**
   * Processes a site directory to extract hostname information
   * @param repoUrl - Repository URL
   * @param sitePath - Path to the site directory
   * @param branch - Branch name
   * @returns Promise that resolves to SiteHostnameInfo
   */
  private async processSiteDirectory(repoUrl: string, sitePath: string, branch: string): Promise<SiteHostnameInfo> {
    const siteInfo: SiteHostnameInfo = {
      sitePath,
      hostnames: [],
      bmNodeFiles: [],
      errors: []
    };

    try {
      const items = await this.getGiteaDirectoryListing(repoUrl, sitePath, branch);
      const bmNodeFiles = items.filter(item => 
        item.type === 'file' && 
        item.name && 
        this.bmNodeFileRegex.test(item.name)
      );

      // Process each bm-node file
      for (const file of bmNodeFiles) {
        const fileName = file.name;
        const fileUrl = file.download_url || this.constructRawUrl(repoUrl, `${sitePath}/${fileName}`, branch);
        
        siteInfo.bmNodeFiles.push(fileName);

        try {
          const content = await this.fetchUrl(fileUrl);
          const hostname = this.extractHostnameFromContent(content);
          
          if (hostname) {
            siteInfo.hostnames.push(hostname);
          } else {
            const error = `No hostname annotation found in ${fileName}`;
            siteInfo.errors.push(error);
          }
        } catch (error) {
          const errorMsg = `Error processing ${fileName}: ${error instanceof Error ? error.message : String(error)}`;
          siteInfo.errors.push(errorMsg);
        }
      }

    } catch (error) {
      const errorMsg = `Error processing site directory ${sitePath}: ${error instanceof Error ? error.message : String(error)}`;
      siteInfo.errors.push(errorMsg);
    }

    return siteInfo;
  }

  /**
   * Recursively discovers all site directories and their hostname information
   * @param repoUrl - Repository URL
   * @param currentPath - Current path being scanned
   * @param branch - Branch name
   * @param siteMap - Accumulator map for site information
   * @returns Promise that resolves to updated site map
   */
  private async discoverSitesRecursively(
    repoUrl: string, 
    currentPath: string = '', 
    branch: string = 'dev',
    siteMap: Map<string, SiteHostnameInfo> = new Map()
  ): Promise<Map<string, SiteHostnameInfo>> {
    try {
      const items = await this.getGiteaDirectoryListing(repoUrl, currentPath, branch);
      
      // Check if current directory is a site directory (contains bm-node files)
      if (this.isSiteDirectory(items)) {
        const siteInfo = await this.processSiteDirectory(repoUrl, currentPath, branch);
        siteMap.set(currentPath || 'root', siteInfo);
      }

      // Recursively scan subdirectories
      const subdirectories = items.filter(item => item.type === 'dir');
      for (const subdir of subdirectories) {
        const dirPath = currentPath ? `${currentPath}/${subdir.name}` : subdir.name;
        await this.discoverSitesRecursively(repoUrl, dirPath, branch, siteMap);
      }

    } catch (error) {
      // Silent error handling - errors are captured in site info
    }

    return siteMap;
  }

  /**
   * Constructs raw file URL for Gitea
   * @param repoUrl - Repository URL
   * @param filePath - File path within repository
   * @param branch - Branch name
   * @returns Raw file URL
   */
  private constructRawUrl(repoUrl: string, filePath: string, branch: string): string {
    const urlParts = repoUrl.replace(/\/$/, '').split('/');
    const owner = urlParts[urlParts.length - 2];
    const repo = urlParts[urlParts.length - 1];
    const baseUrl = urlParts.slice(0, -2).join('/');
    
    return `${baseUrl}/${owner}/${repo}/raw/branch/${branch}/${filePath}`;
  }

  /**
   * Extracts hostname from YAML content using regex
   * @param content - YAML file content as string
   * @returns Extracted hostname or null if not found
   */
  private extractHostnameFromContent(content: string): string | null {
    const match = content.match(this.hostnameRegex);
    return match ? match[1] : null;
  }

  /**
   * Main method: Extracts hostnames from all sites in a Gitea repository
   * @param repoUrl - Repository URL (e.g., https://codehub.jio.indradhanus.com/indradhanus/sites)
   * @param branch - Branch name (default: 'dev')
   * @returns Promise that resolves to Map of site paths to hostname information
   */
  async extractHostnamesFromGiteaRepository(repoUrl: string, branch: string = 'dev'): Promise<Map<string, SiteHostnameInfo>> {
    try {
      // Recursively discover all sites and their hostnames
      const siteMap = await this.discoverSitesRecursively(repoUrl, '', branch);
      return siteMap;
    } catch (error) {
      return new Map();
    }
  }

  /**
   * Legacy method for backward compatibility - extracts from single directory
   */
  async extractHostnamesFromGiteaDirectory(baseUrl: string): Promise<string[]> {
    // Try to convert single directory URL to repository URL format
    const match = baseUrl.match(/^(https:\/\/[^\/]+\/[^\/]+\/[^\/]+)\/raw\/branch\/([^\/]+)\/(.+)$/);
    if (match) {
      const [, repoUrl, branch, path] = match;
      const siteMap = await this.extractHostnamesFromGiteaRepository(repoUrl, branch);
      
      // Return flattened hostnames for backward compatibility
      const allHostnames: string[] = [];
      for (const siteInfo of siteMap.values()) {
        allHostnames.push(...siteInfo.hostnames);
      }
      return allHostnames;
    }
    
    throw new Error('Please use extractHostnamesFromGiteaRepository with repository URL format');
  }
}

// Usage example and main execution
// async function main() {
//   const extractor = new BMNodeHostnameExtractor();

//   // Repository URL - user can provide this as command line argument
//   const repoUrl = process.argv[2] || 'https://codeview.jio.indradhanus.com/indradhanus/sites';
//   const branch = process.argv[3] || 'prod';
  
//   try {
//     const siteMap = await extractor.extractHostnamesFromGiteaRepository(repoUrl, branch);
    
//     if (siteMap.size > 0) {
//       // Output in various formats
//       console.log('\n🗂️  DETAILED SITE MAP:');
//       console.log('='.repeat(80));
      
//       for (const [sitePath, siteInfo] of siteMap) {
//         console.log(`\n📁 ${sitePath}:`);
//         console.log(`   Hostnames: [${siteInfo.hostnames.map(h => `"${h}"`).join(', ')}]`);
//         console.log(`   Files: [${siteInfo.bmNodeFiles.map(f => `"${f}"`).join(', ')}]`);
//         if (siteInfo.errors.length > 0) {
//           console.log(`   Errors: [${siteInfo.errors.map(e => `"${e}"`).join(', ')}]`);
//         }
//       }

//       // JSON Output
//       const jsonOutput = Object.fromEntries(siteMap);
//       console.log('\n💾 JSON OUTPUT:');
//       console.log('='.repeat(80));
//       console.log(JSON.stringify(jsonOutput, null, 2));

//       // TypeScript Map Declaration
//       console.log('\n💻 TYPESCRIPT MAP:');
//       console.log('='.repeat(80));
//       console.log('const siteHostnameMap = new Map<string, SiteHostnameInfo>([');
//       for (const [sitePath, siteInfo] of siteMap) {
//         console.log(`  ["${sitePath}", {`);
//         console.log(`    sitePath: "${sitePath}",`);
//         console.log(`    hostnames: [${siteInfo.hostnames.map(h => `"${h}"`).join(', ')}],`);
//         console.log(`    bmNodeFiles: [${siteInfo.bmNodeFiles.map(f => `"${f}"`).join(', ')}],`);
//         console.log(`    errors: [${siteInfo.errors.map(e => `"${e}"`).join(', ')}]`);
//         console.log('  }],');
//       }
//       console.log(']);');

//       // All hostnames flattened
//       const allHostnames: string[] = [];
//       for (const siteInfo of siteMap.values()) {
//         allHostnames.push(...siteInfo.hostnames);
//       }
      
//       console.log('\n📋 ALL HOSTNAMES (flattened):');
//       console.log('='.repeat(80));
//       console.log(JSON.stringify(allHostnames, null, 2));
      
//     } else {
//       console.log('\n❌ No sites with hostnames were found in the repository.');
//       console.log('\n🔍 Please check:');
//       console.log('  - Repository URL is correct');
//       console.log('  - Branch name is correct');
//       console.log('  - Repository contains directories with bm-node-*.yaml files');
//       console.log('  - Files contain bmac.agent-install.openshift.io/hostname annotations');
//     }
//   } catch (error) {
//     console.error('\n💥 Fatal error:', error instanceof Error ? error.message : String(error));
//     console.log('\n📖 Usage:');
//     console.log('  node script.js <repository-url> [branch-name]');
//     console.log('\n📝 Examples:');
//     console.log('  node script.js https://codehub.jio.indradhanus.com/indradhanus/sites dev');
//     console.log('  node script.js https://codehub.jio.indradhanus.com/indradhanus/sites prod');
//     process.exit(1);
//   }
// }

// Export for use as a module
export { BMNodeHostnameExtractor, SiteHostnameInfo };

// // Run main function if this file is executed directly
// if (require.main === module) {
//   main().catch(console.error);
// }
