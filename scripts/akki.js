const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

// API endpoints
const MP3_API = "https://backendmix.vercel.app/mp3";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";

// Configuration
const TEMP_DOWNLOAD_DIR = path.join(__dirname, "..", "temp_downloads");
const DOWNLOADS_JSON = path.join(__dirname, "..", "akki.json");
const MAX_RETRIES = 5;
const CHANNEL_ID = "UCyBzV_g6Vfv5GM3aMQb3Y_A"; // Hardcoded Channel ID

// Internet Archive configuration
const IA_IDENTIFIER = "akkidark";
const IA_ACCESS_KEY = "cCYXD3V4ke4YkXLI";
const IA_SECRET_KEY = "qZHSAtgw5TJXkpZa";
const IA_BASE_URL = `https://archive.org/serve/${IA_IDENTIFIER}/`;

// Ensure the download directory exists
fs.ensureDirSync(TEMP_DOWNLOAD_DIR);

// Load existing downloads data
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
        console.log(`📋 Loaded ${Object.keys(downloadsData).length} existing downloads from JSON`);
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

/**
 * Upload multiple files to Internet Archive with progress indication
 * @param {Array} filesToUpload Array of {filePath, videoId, title} objects
 * @returns {Array} Results with success/failure for each file
 */
async function batchUploadToInternetArchive(filesToUpload) {
    console.log(`📤 Batch uploading ${filesToUpload.length} files to Internet Archive...`);
    
    // Create Python script for batch upload with progress updates
    const pythonScript = `
import os
import sys
import json
import time
import internetarchive

# Load batch data
batch_data = json.loads(sys.argv[1])
total_files = len(batch_data)

# Internet Archive credentials
access_key = "${IA_ACCESS_KEY}"
secret_key = "${IA_SECRET_KEY}"
identifier = "${IA_IDENTIFIER}"

# Process each file
results = []
progress_file = os.path.join("${TEMP_DOWNLOAD_DIR}", "upload_progress.json")

# Initialize progress tracking
progress_data = {
    "total": total_files,
    "completed": 0,
    "current_file": "",
    "success_count": 0,
    "failed_count": 0,
    "status_by_id": {}
}

def update_progress(video_id, status, message=""):
    progress_data["completed"] += 1
    progress_data["current_file"] = video_id
    
    if status:
        progress_data["success_count"] += 1
    else:
        progress_data["failed_count"] += 1
    
    progress_data["status_by_id"][video_id] = {
        "status": "success" if status else "failed",
        "message": message
    }
    
    # Write progress to file
    with open(progress_file, 'w') as f:
        json.dump(progress_data, f)
    
    # Print progress for stdout capture
    percent = (progress_data["completed"] / progress_data["total"]) * 100
    print(f"PROGRESS_UPDATE: {percent:.1f}% complete ({progress_data['completed']}/{progress_data['total']}) - Currently processing: {video_id}")

# Start with empty progress file
with open(progress_file, 'w') as f:
    json.dump(progress_data, f)

for index, item in enumerate(batch_data):
    filepath = item["filePath"]
    video_id = item["videoId"]
    title = item["title"]
    filename = os.path.basename(filepath)
    
    print(f"Uploading {filename} ({index+1}/{total_files})...")
    
    try:
        response = internetarchive.upload(
            identifier=identifier,
            files=[filepath],
            metadata={
                "title": title,
                "mediatype": "audio",
                "collection": "opensource_audio",
                "creator": "YouTube Clone - ShradhaKD",
                "youtube_id": video_id
            },
            config={
                "s3": {
                    "access": access_key,
                    "secret": secret_key
                }
            },
            verbose=True
        )
        
        success = True
        error_message = ""
        
        for r in response:
            if r.status_code != 200:
                error_message = f"Upload failed with status {r.status_code}"
                print(f"❌ Upload failed for {filename} with status {r.status_code}: {r.text}")
                success = False
            else:
                print(f"✅ Successfully uploaded {filename}")
        
        update_progress(video_id, success, error_message)
        
        results.append({
            "videoId": video_id,
            "success": success
        })
        
    except Exception as e:
        error_str = str(e)
        print(f"❌ Exception uploading {filename}: {error_str}")
        update_progress(video_id, False, error_str)
        
        results.append({
            "videoId": video_id,
            "success": False
        })

# Output results as JSON
print("FINAL_RESULTS:" + json.dumps(results))
`;

    try {
        const scriptPath = path.join(TEMP_DOWNLOAD_DIR, "batch_upload_script.py");
        fs.writeFileSync(scriptPath, pythonScript);
        
        // Create JSON string of files to upload
        const batchDataJson = JSON.stringify(filesToUpload);
        
        // Create progress tracking function
        const progressFilePath = path.join(TEMP_DOWNLOAD_DIR, "upload_progress.json");
        
        // Setup progress monitoring
        const progressInterval = setInterval(() => {
            try {
                if (fs.existsSync(progressFilePath)) {
                    const progressData = JSON.parse(fs.readFileSync(progressFilePath, "utf-8"));
                    const percent = (progressData.completed / progressData.total) * 100;
                    const progressBar = createProgressBar(percent);
                    
                    process.stdout.write(`\r${progressBar} ${percent.toFixed(1)}% | ${progressData.completed}/${progressData.total} | Success: ${progressData.success_count} | Failed: ${progressData.failed_count}`);
                    
                    if (progressData.current_file) {
                        process.stdout.write(` | Current: ${progressData.current_file}`);
                    }
                }
            } catch (err) {
                // Ignore progress reading errors
            }
        }, 1000);
        
        // Run Python upload script with batch data
        const result = spawnSync("python", [scriptPath, batchDataJson], {
            encoding: "utf-8",
            stdio: "pipe",
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large output
        });
        
        // Stop progress monitoring
        clearInterval(progressInterval);
        process.stdout.write("\n"); // Move to next line after progress bar
        
        if (result.status !== 0) {
            console.error(`❌ Batch upload script failed: ${result.stderr}`);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
        
        // Try to parse results from the script output
        try {
            // Find and extract the JSON part from the output
            const outputLines = result.stdout.split('\n');
            const jsonLine = outputLines.filter(line => line.includes('FINAL_RESULTS:')).pop();
            
            if (jsonLine) {
                const jsonStr = jsonLine.replace('FINAL_RESULTS:', '');
                return JSON.parse(jsonStr);
            } else {
                console.error("❌ Could not find JSON results in script output");
                return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
            }
        } catch (parseErr) {
            console.error(`❌ Failed to parse upload results: ${parseErr.message}`);
            console.log("Script output:", result.stdout);
            return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
        }
    } catch (err) {
        console.error(`❌ Error in batch upload: ${err.message}`);
        return filesToUpload.map(item => ({ videoId: item.videoId, success: false }));
    } finally {
        // Clean up progress file
        try {
            if (fs.existsSync(progressFilePath)) {
                fs.unlinkSync(progressFilePath);
            }
        } catch (err) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Create a visual progress bar
 * @param {number} percent Percentage complete (0-100)
 * @returns {string} ASCII progress bar
 */
function createProgressBar(percent) {
    const width = 30;
    const completed = Math.floor(width * (percent / 100));
    const remaining = width - completed;
    
    return `[${'='.repeat(completed)}${'-'.repeat(remaining)}]`;
}

/**
 * Display download progress
 * @param {number} current Current index
 * @param {number} total Total files
 * @param {string} videoId Current video ID
 */
function showDownloadProgress(current, total, videoId) {
    const percent = (current / total) * 100;
    const progressBar = createProgressBar(percent);
    
    process.stdout.write(`\r${progressBar} ${percent.toFixed(1)}% | ${current}/${total} | Downloading: ${videoId}`);
}

/**
 * Commit changes to the downloads.json file
 */
function commitChangesToJson() {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Update downloads.json with newly processed videos"`);
        execSync("git push");
        console.log(`📤 Committed and pushed updates to downloads.json`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}

/**
 * Main function to download videos and upload to Internet Archive
 */
(async () => {
    try {
        console.log(`🔍 Fetching videos for channel ID: ${CHANNEL_ID}...`);
        const response = await axios.get(`${CHANNEL_API}/${CHANNEL_ID}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error("❌ No videos found for this channel.");
            process.exit(1);
        }

        const videoIds = response.data.videos;
        console.log(`📹 Found ${videoIds.length} videos, checking which ones need processing...`);

        // Filter videos that need processing
        const videosToProcess = [];
        for (const videoId of videoIds) {
            if (!(downloadsData[videoId] && downloadsData[videoId].filePath)) {
                videosToProcess.push(videoId);
            }
        }
        
        const skippedCount = videoIds.length - videosToProcess.length;
        console.log(`⏭️ Skipping ${skippedCount} already processed videos`);
        console.log(`🔄 Processing ${videosToProcess.length} new videos`);

        let processedCount = 0;
        let errorCount = 0;
        
        // Track downloaded files for batch upload
        const downloadedFiles = [];
        const failedIds = [];

        // PHASE 1: DOWNLOAD ALL FILES
        console.log(`\n📥 PHASE 1: DOWNLOADING ALL FILES`);
        console.log(`${'='.repeat(50)}`);
        
        for (let i = 0; i < videosToProcess.length; i++) {
            const videoId = videosToProcess[i];
            const filename = `${videoId}.webm`;
            const filePath = path.join(TEMP_DOWNLOAD_DIR, filename);

            // Show download progress
            showDownloadProgress(i + 1, videosToProcess.length, videoId);

            let downloadSuccess = false;
            let videoTitle = `Video ${videoId}`;
            
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    // Clear the current line for attempt message
                    process.stdout.write("\r" + " ".repeat(80) + "\r");
                    console.log(`\n🔄 Download attempt ${attempt}/${MAX_RETRIES} for ${videoId}...`);

                    // Get the download URL and filename from the MP3 API
                    const downloadResponse = await axios.get(`${MP3_API}/${videoId}`);
                    const { url, filename: titleFromApi } = downloadResponse.data;

                    if (!url) {
                        throw new Error("No download URL returned from API");
                    }

                    // Clean up filename to use as title (remove .mp3 extension if present)
                    videoTitle = titleFromApi 
                        ? titleFromApi.replace(/\.mp3$/, '').trim() 
                        : `Video ${videoId}`;

                    // Download the audio file
                    const writer = fs.createWriteStream(filePath);
                    const audioResponse = await axios({
                        url,
                        method: "GET",
                        responseType: "stream",
                        timeout: 60000
                    });

                    audioResponse.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on("finish", resolve);
                        writer.on("error", reject);
                    });

                    // Get file size
                    const fileSize = fs.statSync(filePath).size;

                    if (fileSize === 0) {
                        throw new Error("Downloaded file size is 0 bytes");
                    }

                    console.log(`✅ Downloaded ${filename} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                    console.log(`📝 Title: ${videoTitle}`);

                    downloadedFiles.push({
                        filePath: filePath,
                        videoId: videoId,
                        title: videoTitle,
                        size: fileSize
                    });
                    
                    downloadSuccess = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ Error downloading ${videoId}: ${err.message}`);
                    
                    // Clean up partial download if it exists
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            console.log(`🗑️ Removed failed download: ${filePath}`);
                        } catch (cleanupErr) {
                            console.error(`⚠️ Failed to clean up file: ${cleanupErr.message}`);
                        }
                    }
                    
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed to download ${videoId} after ${MAX_RETRIES} attempts, skipping.`);
                        failedIds.push(videoId);
                        errorCount++;
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            if (!downloadSuccess) {
                console.error(`🚨 Failed to download: ${videoId}`);
            }
        }
        
        // End of download phase - move to next line
        console.log("\n" + `${'='.repeat(50)}`);
        console.log(`📥 Download phase complete: ${downloadedFiles.length} files downloaded, ${failedIds.length} failed`);

        // PHASE 2: BATCH UPLOAD ALL DOWNLOADED FILES
        console.log(`\n📤 PHASE 2: BATCH UPLOADING ${downloadedFiles.length} FILES`);
        console.log(`${'='.repeat(50)}`);
        
        if (downloadedFiles.length > 0) {
            // Batch upload all files
            const uploadResults = await batchUploadToInternetArchive(downloadedFiles);
            
            console.log(`\n${'-'.repeat(50)}`);
            console.log(`📊 Upload Results Summary:`);
            
            // Calculate upload success stats
            const successfulUploads = uploadResults.filter(r => r.success).length;
            const failedUploads = uploadResults.filter(r => !r.success).length;
            console.log(`✅ Successfully uploaded: ${successfulUploads}/${uploadResults.length} files (${((successfulUploads/uploadResults.length)*100).toFixed(1)}%)`);
            console.log(`❌ Failed uploads: ${failedUploads}`);
            
            // Process results and update downloads.json
            console.log(`\n📝 Updating records in downloads.json...`);
            
            for (const result of uploadResults) {
                const { videoId, success } = result;
                const fileInfo = downloadedFiles.find(file => file.videoId === videoId);
                
                if (success && fileInfo) {
                    const filename = path.basename(fileInfo.filePath);
                    const iaFilePath = `${IA_BASE_URL}${filename}`;
                    
                    // Update downloads.json
                    downloadsData[videoId] = {
                        title: fileInfo.title,
                        id: videoId,
                        filePath: iaFilePath,
                        size: fileInfo.size,
                        uploadDate: new Date().toISOString()
                    };
                    
                    processedCount++;
                } else if (!success) {
                    errorCount++;
                }
            }
            
            // Save updated downloads JSON
            fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));
            console.log(`📝 Updated downloads.json with ${processedCount} new entries`);
            
            // Commit changes
            if (processedCount > 0) {
                commitChangesToJson();
            }
        } else {
            console.log(`⏭️ No new files to upload`);
        }
        console.log(`${'='.repeat(50)}`);

        // PHASE 3: CLEANUP
        console.log(`\n🧹 PHASE 3: CLEANING UP DOWNLOADED FILES`);
        console.log(`${'='.repeat(50)}`);
        
        // Clean up downloaded files
        let cleanedUp = 0;
        for (const fileInfo of downloadedFiles) {
            try {
                if (fs.existsSync(fileInfo.filePath)) {
                    fs.unlinkSync(fileInfo.filePath);
                    cleanedUp++;
                }
            } catch (err) {
                console.error(`⚠️ Error deleting ${fileInfo.filePath}: ${err.message}`);
            }
        }
        console.log(`🗑️ Removed ${cleanedUp} downloaded files`);
        console.log(`${'='.repeat(50)}`);

        console.log(`\n📊 Final Summary:`);
        console.log(`✅ Successfully processed: ${processedCount} videos`);
        console.log(`⏭️ Skipped (already processed): ${skippedCount} videos`);
        console.log(`❌ Failed: ${errorCount} videos`);
        console.log(`🌐 Internet Archive collection: https://archive.org/details/${IA_IDENTIFIER}`);

    } catch (error) {
        console.error("❌ Error:", error.message);
        process.exit(1);
    } finally {
        // Double-check and clean up any remaining files in temp directory
        try {
            const tempFiles = fs.readdirSync(TEMP_DOWNLOAD_DIR)
                .filter(file => file.endsWith('.webm'));
            
            if (tempFiles.length > 0) {
                console.log(`🧹 Cleaning up ${tempFiles.length} remaining temporary files...`);
                tempFiles.forEach(file => {
                    const filePath = path.join(TEMP_DOWNLOAD_DIR, file);
                    fs.unlinkSync(filePath);
                });
            }
        } catch (err) {
            console.error(`⚠️ Error during final cleanup: ${err.message}`);
        }
    }
})();
