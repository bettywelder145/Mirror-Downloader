const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
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
            
            writer.on('finish', () => {
                const finalSize = fs.statSync(filePath).size;
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
                    downloadUrl
                });
                
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

server.listen(PORT, () => {
    console.log(`Mirror Downloader running at http://localhost:${PORT}`);
});
