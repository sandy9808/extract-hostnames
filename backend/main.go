package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// SiteHostnameInfo stores the extracted information for a site.
type SiteHostnameInfo struct {
	SitePath    string   `json:"sitePath"`
	Hostnames   []string `json:"hostnames"`
	BMNodeFiles []string `json:"bmNodeFiles"`
	Errors      []string `json:"errors"`
}

// GiteaFile represents a file or directory in a Gitea repository.
type GiteaFile struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	DownloadURL string `json:"download_url"`
}

var (
	bmNodeFileRegex = regexp.MustCompile(`bm-node-.+\.yaml$`)
	hostnameRegex   = regexp.MustCompile(`bmac\.agent-install\.openshift\.io/hostname:\s*["']?([^
"'\s]+)["']?`)
)

func main() {
	http.HandleFunc("/api/data", dataHandler)
	fmt.Println("Server is running on http://localhost:3001")
	log.Fatal(http.ListenAndServe(":3001", nil))
}

func dataHandler(w http.ResponseWriter, r *http.Request) {
	log.Println("Received request for /api/data SSE stream")

	// Set headers for SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported!", http.StatusInternalServerError)
		return
	}

	repoURL := "https://codeview.jio.indradhanus.com/indradhanus/sites"
	branch := "prod"
	
	siteInfoChan := make(chan SiteHostnameInfo)

	// Start fetching data in a new goroutine
	go func() {
		defer close(siteInfoChan) // Close channel when done
		extractHostnamesFromGiteaRepository(repoURL, branch, siteInfoChan)
	}()

	// Listen for new site info and send it to the client
	for siteInfo := range siteInfoChan {
		jsonData, err := json.Marshal(siteInfo)
		if err != nil {
			log.Printf("Error marshalling JSON: %v", err)
			continue
		}
		// Format as an SSE message
		fmt.Fprintf(w, "data: %s\n\n", jsonData)
		flusher.Flush() // Flush the data to the client
	}

	log.Println("Finished streaming data.")
}


func fetchURL(url string) ([]byte, error) {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			MinVersion:         tls.VersionTLS12,
			MaxVersion:         tls.VersionTLS12,
		},
	}
	client := &http.Client{Transport: tr, Timeout: 15 * time.Second}

	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s for %s", resp.StatusCode, resp.Status, url)
	}

	return ioutil.ReadAll(resp.Body)
}

func convertToGiteaAPIURL(repoURL, path, branch string) string {
	urlParts := strings.Split(strings.TrimRight(repoURL, "/"), "/")
	baseURL := strings.Join(urlParts[:len(urlParts)-2], "/")
	owner := urlParts[len(urlParts)-2]
	repo := urlParts[len(urlParts)-1]

	pathSegment := ""
	if path != "" {
		pathSegment = "/" + path
	}
	return fmt.Sprintf("%s/api/v1/repos/%s/%s/contents%s?ref=%s", baseURL, owner, repo, pathSegment, branch)
}

func getGiteaDirectoryListing(repoURL, path, branch string) ([]GiteaFile, error) {
	apiURL := convertToGiteaAPIURL(repoURL, path, branch)
	body, err := fetchURL(apiURL)
	if err != nil {
		return nil, err
	}

	var files []GiteaFile
	if err := json.Unmarshal(body, &files); err != nil {
		// Gitea can return an object instead of an array for a single file view
		// We can ignore this error as we are only interested in directories
		return nil, nil
	}
	return files, nil
}

func isSiteDirectory(items []GiteaFile) bool {
	for _, item := range items {
		if item.Type == "file" && bmNodeFileRegex.MatchString(item.Name) {
			return true
		}
	}
	return false
}

func processSiteDirectory(repoURL, sitePath, branch string, siteInfoChan chan<- SiteHostnameInfo) {
	siteInfo := SiteHostnameInfo{SitePath: sitePath, Hostnames: []string{}, BMNodeFiles: []string{}, Errors: []string{}}

	items, err := getGiteaDirectoryListing(repoURL, sitePath, branch)
	if err != nil {
		siteInfo.Errors = append(siteInfo.Errors, err.Error())
		siteInfoChan <- siteInfo
		return
	}

	for _, file := range items {
		if file.Type == "file" && bmNodeFileRegex.MatchString(file.Name) {
			siteInfo.BMNodeFiles = append(siteInfo.BMNodeFiles, file.Name)
			// Always construct the URL to ensure consistent hostname
			fileURL := constructRawURL(repoURL, sitePath+"/"+file.Name, branch)

			content, err := fetchURL(fileURL)
			if err != nil {
				siteInfo.Errors = append(siteInfo.Errors, fmt.Sprintf("Error processing %s: %v", file.Name, err))
				continue
			}

			match := hostnameRegex.FindStringSubmatch(string(content))
			if len(match) > 1 {
				siteInfo.Hostnames = append(siteInfo.Hostnames, match[1])
			} else {
				siteInfo.Errors = append(siteInfo.Errors, fmt.Sprintf("No hostname annotation found in %s", file.Name))
			}
		}
	}
	siteInfoChan <- siteInfo
}

func discoverSitesRecursively(repoURL, currentPath, branch string, siteInfoChan chan<- SiteHostnameInfo, wg *sync.WaitGroup) {
	defer wg.Done()

	items, err := getGiteaDirectoryListing(repoURL, currentPath, branch)
	if err != nil {
		log.Printf("Error getting directory listing for %s: %v", currentPath, err)
		return
	}

	if isSiteDirectory(items) {
		pathKey := currentPath
		if pathKey == "" {
			pathKey = "root"
		}
		processSiteDirectory(repoURL, pathKey, branch, siteInfoChan)
	}

	for _, subdir := range items {
		if subdir.Type == "dir" {
			dirPath := subdir.Name
			if currentPath != "" {
				dirPath = currentPath + "/" + subdir.Name
			}
			wg.Add(1)
			go discoverSitesRecursively(repoURL, dirPath, branch, siteInfoChan, wg)
		}
	}
}

func constructRawURL(repoURL, filePath, branch string) string {
	urlParts := strings.Split(strings.TrimRight(repoURL, "/"), "/")
	owner := urlParts[len(urlParts)-2]
	repo := urlParts[len(urlParts)-1]
	baseURL := strings.Join(urlParts[:len(urlParts)-2], "/")
	return fmt.Sprintf("%s/%s/%s/raw/branch/%s/%s", baseURL, owner, repo, branch, filePath)
}

func extractHostnamesFromGiteaRepository(repoURL, branch string, siteInfoChan chan<- SiteHostnameInfo) {
	var wg sync.WaitGroup
	wg.Add(1)
	go discoverSitesRecursively(repoURL, "", branch, siteInfoChan, &wg)
	wg.Wait()
}