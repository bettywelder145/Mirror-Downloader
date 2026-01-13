const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const app = express();

// Google Drive Configuration
const GOOGLE_DRIVE_FOLDER_NAME = 'mirror_downloads';
let driveClient = null;
let driveFolderId = null;

// Initialize Google Drive client
async function initGoogleDrive() {
    try {
        // Load service account credentials from file
        const credentialsPath = path.join(__dirname, 'credentials.json');
        
        if (!fs.existsSync(credentialsPath)) {
            console.error('❌ credentials.json not found! Please add your Google Service Account credentials.');
            console.log('📝 Instructions:');
            console.log('   1. Go to Google Cloud Console → APIs & Services → Credentials');
            console.log('   2. Create a Service Account and download the JSON key');
            console.log('   3. Save it as "credentials.json" in the project root');
            console.log('   4. Enable Google Drive API in your project');
            console.log('   5. Share the "mirror_downloads" folder with the service account email');
            return false;
        }
        
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        
        driveClient = google.drive({ version: 'v3', auth });
        
        // Find or create the mirror_downloads folder
        driveFolderId = await getOrCreateFolder(GOOGLE_DRIVE_FOLDER_NAME);
        
        console.log(`✅ Google Drive connected! Folder ID: ${driveFolderId}`);
        return true;
    } catch (error) {
        console.error('❌ Failed to initialize Google Drive:', error.message);
        return false;
    }
}

// Get or create the mirror_downloads folder
async function getOrCreateFolder(folderName) {
    try {
        // Search for existing folder
        const response = await driveClient.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive'
        });
        
        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }
        
        // Create new folder
        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder'
        };
        
        const folder = await driveClient.files.create({
            resource: folderMetadata,
            fields: 'id'
        });
        
        // Make folder publicly accessible
        await driveClient.permissions.create({
            fileId: folder.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });
        
        console.log(`📁 Created new folder: ${folderName}`);
        return folder.data.id;
    } catch (error) {
        console.error('Error creating folder:', error.message);
        throw error;
    }
}

// Upload file to Google Drive
async function uploadToGoogleDrive(filePath, filename) {
    if (!driveClient || !driveFolderId) {
        throw new Error('Google Drive not initialized');
    }
    
    const fileMetadata = {
        name: filename,
        parents: [driveFolderId]
    };
    
    const media = {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(filePath)
    };
    
    // Upload file
    const file = await driveClient.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, size, webContentLink'
    });
    
    // Make file publicly accessible
    await driveClient.permissions.create({
        fileId: file.data.id,
        requestBody: {
            role: 'reader',
            type: 'anyone'
        }
    });
    
    // Get the direct download link
    const directLink = `https://drive.google.com/uc?export=download&id=${file.data.id}`;
    
    return {
        fileId: file.data.id,
        fileName: file.data.name,
        directLink: directLink,
        webLink: `https://drive.google.com/file/d/${file.data.id}/view`
    };
}

// Delete local file after upload
function deleteLocalFile(filePath) {
    fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
            console.error('Failed to delete local file:', err);
        } else {
            console.log('🗑️ Local file deleted after upload');
        }
    });
}
const server = http.createServer(app);

// Optimize server for maximum throughput
server.maxHeadersCount = 0;
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

const io = new Server(server, {
    maxHttpBufferSize: 1e8, // 100MB
    pingTimeout: 60000,
    pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Serve static files
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));

// Maximum speed download endpoint with aggressive buffering
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(downloadsDir, filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }
    
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Disable Nagle's algorithm for faster TCP transmission
    req.socket.setNoDelay(true);
    // Increase TCP buffer sizes for maximum throughput
    req.socket.setKeepAlive(true, 0);
    
    // Set headers for optimal download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    if (range) {
        // Handle range requests for resume support
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunksize);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        // Maximum buffer size: 8MB chunks for dedicated VPS
        const stream = fs.createReadStream(filePath, { 
            start, 
            end, 
            highWaterMark: 8 * 1024 * 1024 
        });
        stream.pipe(res);
    } else {
        // Full file download with maximum streaming speed
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        // Maximum buffer size: 8MB chunks for dedicated VPS
        const stream = fs.createReadStream(filePath, { 
            highWaterMark: 8 * 1024 * 1024 
        });
        stream.pipe(res);
    }
});

// Store active downloads
const activeDownloads = new Map();

// Constants
const DEFAULT_FILENAME_PREFIX = 'download_';

// Get filename from URL or Content-Disposition header
function getFilename(url, headers) {
    // Try to get from Content-Disposition header
    const contentDisposition = headers['content-disposition'];
    if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match && match[1]) {
            return match[1].replace(/['"]/g, '');
        }
    }
    
    // Extract from URL
    try {
        const urlPath = new URL(url).pathname;
        const filename = path.basename(urlPath);
        if (filename && filename !== '' && filename !== '/') {
            return decodeURIComponent(filename);
        }
    } catch (e) {
        // URL parsing failed
    }
    
    // Default filename with UUID
    return `${DEFAULT_FILENAME_PREFIX}${uuidv4().substring(0, 8)}`;
}

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('start-download', async (data) => {
        const { url } = data;
        const downloadId = uuidv4();
        
        console.log(`Starting download: ${url}`);
        
        try {
            // Make HEAD request first to get file info
            let fileSize = 0;
            let filename = '';
            
            try {
                const headResponse = await axios.head(url, { 
                    timeout: 10000,
                    maxRedirects: 5
                });
                fileSize = parseInt(headResponse.headers['content-length']) || 0;
                filename = getFilename(url, headResponse.headers);
            } catch (e) {
                // HEAD request failed, continue with GET
                filename = getFilename(url, {});
            }
            
            // Generate unique filename
            const uniqueFilename = `${uuidv4().substring(0, 8)}_${filename}`;
            const filePath = path.join(downloadsDir, uniqueFilename);
            
            // Start download with GET request - maximum speed configuration
            const response = await axios({
                method: 'GET',
                url: url,
                responseType: 'stream',
                timeout: 0,
                maxRedirects: 5,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                // Optimize for high-speed downloads
                decompress: false,
                httpAgent: new http.Agent({ 
                    keepAlive: true,
                    keepAliveMsecs: 1000,
                    maxSockets: Infinity,
                    maxFreeSockets: 256
                })
            });
            
            // Update file size if we didn't get it from HEAD
            if (!fileSize) {
                fileSize = parseInt(response.headers['content-length']) || 0;
            }
            if (!filename || filename.startsWith(DEFAULT_FILENAME_PREFIX)) {
                filename = getFilename(url, response.headers);
            }
            
            // Maximum write performance with 8MB buffer
            const writer = fs.createWriteStream(filePath, { 
                highWaterMark: 8 * 1024 * 1024 
            });
            let downloadedBytes = 0;
            let lastProgress = 0;
            const startTime = Date.now();
            
            // Store download info
            activeDownloads.set(downloadId, {
                filename,
                filePath,
                fileSize,
                downloadedBytes: 0,
                status: 'downloading'
            });
            
            socket.emit('download-started', {
                downloadId,
                filename,
                fileSize
            });
            
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const progress = fileSize > 0 ? Math.round((downloadedBytes / fileSize) * 100) : -1;
                const elapsedTime = (Date.now() - startTime) / 1000;
                const speed = downloadedBytes / elapsedTime; // bytes per second
                
                // Send progress update (throttle to avoid flooding)
                if (progress !== lastProgress || progress === -1) {
                    lastProgress = progress;
                    socket.emit('download-progress', {
                        downloadId,
                        downloadedBytes,
                        fileSize,
                        progress,
                        speed: formatSpeed(speed)
                    });
                }
                
                activeDownloads.set(downloadId, {
                    ...activeDownloads.get(downloadId),
                    downloadedBytes,
                    status: 'downloading'
                });
            });
            
            response.data.pipe(writer);
            
            writer.on('finish', async () => {
                const finalSize = fs.statSync(filePath).size;
                
                // Upload to Google Drive
                if (driveClient && driveFolderId) {
                    socket.emit('download-progress', {
                        downloadId,
                        downloadedBytes: finalSize,
                        fileSize: finalSize,
                        progress: 100,
                        speed: 'Uploading to Google Drive...'
                    });
                    
                    try {
                        console.log(`📤 Uploading to Google Drive: ${filename}`);
                        const driveResult = await uploadToGoogleDrive(filePath, filename);
                        
                        activeDownloads.set(downloadId, {
                            ...activeDownloads.get(downloadId),
                            downloadedBytes: finalSize,
                            status: 'completed',
                            downloadUrl: driveResult.directLink,
                            driveFileId: driveResult.fileId
                        });
                        
                        socket.emit('download-complete', {
                            downloadId,
                            filename,
                            fileSize: finalSize,
                            downloadUrl: driveResult.directLink,
                            driveLink: driveResult.webLink,
                            source: 'google_drive'
                        });
                        
                        console.log(`✅ Uploaded to Google Drive: ${filename}`);
                        console.log(`📎 Direct link: ${driveResult.directLink}`);
                        
                        // Delete local file after successful upload
                        deleteLocalFile(filePath);
                        
                    } catch (uploadError) {
                        console.error('❌ Google Drive upload failed:', uploadError.message);
                        
                        // Fallback to local download link
                        const localDownloadUrl = `/downloads/${uniqueFilename}`;
                        
                        activeDownloads.set(downloadId, {
                            ...activeDownloads.get(downloadId),
                            downloadedBytes: finalSize,
                            status: 'completed',
                            downloadUrl: localDownloadUrl
                        });
                        
                        socket.emit('download-complete', {
                            downloadId,
                            filename,
                            fileSize: finalSize,
                            downloadUrl: localDownloadUrl,
                            source: 'local',
                            warning: 'Google Drive upload failed, using local link'
                        });
                    }
                } else {
                    // No Google Drive configured, use local link
                    const downloadUrl = `/downloads/${uniqueFilename}`;
                    
                    activeDownloads.set(downloadId, {
                        ...activeDownloads.get(downloadId),
                        downloadedBytes: finalSize,
                        status: 'completed',
                        downloadUrl
                    });
                    
                    socket.emit('download-complete', {
                        downloadId,
                        filename,
                        fileSize: finalSize,
                        downloadUrl,
                        source: 'local',
                        warning: 'Google Drive not configured'
                    });
                }
                
                console.log(`Download complete: ${filename}`);
            });
            
            writer.on('error', (err) => {
                console.error('Write error:', err);
                socket.emit('download-error', {
                    downloadId,
                    error: 'Failed to save file'
                });
                
                // Clean up asynchronously
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                        console.error('Failed to clean up file:', unlinkErr);
                    }
                });
                activeDownloads.delete(downloadId);
            });
            
        } catch (error) {
            console.error('Download error:', error.message);
            socket.emit('download-error', {
                downloadId,
                error: error.message || 'Failed to download file'
            });
            activeDownloads.delete(downloadId);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) {
        return `${bytesPerSecond.toFixed(0)} B/s`;
    } else if (bytesPerSecond < 1024 * 1024) {
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    } else {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// API endpoint to list downloads
app.get('/api/downloads', (req, res) => {
    const downloads = [];
    activeDownloads.forEach((value, key) => {
        downloads.push({
            id: key,
            ...value
        });
    });
    res.json(downloads);
});

server.listen(PORT, async () => {
    console.log(`Mirror Downloader running at http://localhost:${PORT}`);
    
    // Initialize Google Drive
    const driveInitialized = await initGoogleDrive();
    if (driveInitialized) {
        console.log('🚀 Files will be uploaded to Google Drive after download');
    } else {
        console.log('⚠️ Google Drive not configured - files will be served locally');
    }
});
