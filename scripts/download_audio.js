const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const COBALT_API = "https://cobalt-api.kwiatekmiki.com";
const CHANNEL_API = "https://backendmix-emergeny.vercel.app/list";
const DOWNLOAD_DIR = path.join(__dirname, "..", "akkidark");
const DOWNLOADS_JSON = path.join(__dirname, "..", "downloads.json");
const MAX_RETRIES = 3;
const CHANNEL_ID = "UCrB8j1YCbuYhIcImwNkJgCg"; // 🔥 Hardcoded Channel ID

// Ensure the download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Load existing downloads data
let downloadsData = {};
if (fs.existsSync(DOWNLOADS_JSON)) {
    try {
        downloadsData = JSON.parse(fs.readFileSync(DOWNLOADS_JSON, "utf-8"));
    } catch (err) {
        console.error("❌ Failed to load downloads.json, resetting file.");
        downloadsData = {};
    }
}

(async () => {
    try {
        console.log(`🔍 Fetching videos for channel ID: ${CHANNEL_ID}...`);
        const response = await axios.get(`${CHANNEL_API}/${CHANNEL_ID}`);

        if (!response.data || !response.data.videos || response.data.videos.length === 0) {
            console.error("❌ No videos found for this channel.");
            process.exit(1);
        }

        const videos = response.data.videos;
        console.log(`📹 Found ${videos.length} videos. Checking for new downloads...`);

        for (const video of videos) {
            const videoId = video.id;
            const videoTitle = video.title;
            const filePath = path.join(DOWNLOAD_DIR, `${videoId}.mp3`);

            // Skip if already downloaded and valid
            if (downloadsData[videoId] && fs.existsSync(filePath) && downloadsData[videoId].size > 0) {
                console.log(`⏭️ Skipping ${videoTitle}, already downloaded and valid.`);
                continue;
            }

            console.log(`🎵 Downloading audio for: ${videoTitle} (ID: ${videoId})...`);

            let success = false;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    console.log(`🔄 Attempt ${attempt}/${MAX_RETRIES}...`);

                    // Get the download URL from Cobalt API
                    const downloadResponse = await axios.post(
                        `${COBALT_API}/`,
                        {
                            url: `https://www.youtube.com/watch?v=${videoId}`,
                            audioFormat: "mp3",
                            downloadMode: "audio"
                        },
                        {
                            headers: {
                                "Accept": "application/json",
                                "Content-Type": "application/json"
                            }
                        }
                    );

                    const { status, url } = downloadResponse.data;
                    if (status !== "redirect" && status !== "tunnel") {
                        throw new Error("Failed to retrieve audio URL");
                    }

                    // Download the audio file
                    const writer = fs.createWriteStream(filePath);
                    const audioResponse = await axios({ url, method: "GET", responseType: "stream" });

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

                    console.log(`✅ Downloaded: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);

                    // Save to downloads.json
                    downloadsData[videoId] = {
                        title: videoTitle,
                        id: videoId,
                        filePath: filePath,
                        size: fileSize
                    };

                    fs.writeFileSync(DOWNLOADS_JSON, JSON.stringify(downloadsData, null, 2));

                    // Commit the file immediately
                    commitFile(filePath, videoId);
                    success = true;
                    break;
                } catch (err) {
                    console.error(`⚠️ Error downloading ${videoTitle}: ${err.message}`);
                    if (attempt === MAX_RETRIES) {
                        console.error(`❌ Failed after ${MAX_RETRIES} attempts, skipping.`);
                    }
                }
            }

            if (!success) {
                console.error(`🚨 Skipped: ${videoTitle} due to repeated errors.`);
            }
        }
    } catch (error) {
        console.error("❌ Error:", error.message);
    }
})();

/**
 * Commits a downloaded file to the repository
 * @param {string} filePath
 * @param {string} videoId
 */
function commitFile(filePath, videoId) {
    try {
        execSync("git config --global user.name 'github-actions'");
        execSync("git config --global user.email 'github-actions@github.com'");
        execSync(`git add "${filePath}" "${DOWNLOADS_JSON}"`);
        execSync(`git commit -m "Add downloaded audio for ${videoId}"`);
        execSync("git push");
        console.log(`📤 Committed and pushed ${filePath}`);
    } catch (err) {
        console.error("❌ Error committing file:", err.message);
    }
}
