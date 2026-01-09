# Mirror-Downloader
Slow Download ? This repo will get your download link, download it and will give you a new link for faster download

## Features
- 🚀 Fast file downloads with real-time progress tracking
- 📊 Live progress bar with download speed display
- 🔗 Get a new mirror link for your downloaded files
- 💻 Works great on GitHub Codespaces

## Deploy with GitHub Codespaces

### Step 1: Create a Codespace
1. Go to this repository on GitHub
2. Click the green **Code** button
3. Select the **Codespaces** tab
4. Click **Create codespace on main**

### Step 2: Install and Run
Once your Codespace is ready, run these commands in the terminal:

```bash
npm install
npm start
```

### Step 3: Open the Web Interface
1. When the server starts, you'll see: `Mirror Downloader running at http://localhost:3000`
2. A popup will appear asking to open in browser - click **Open in Browser**
3. Or go to the **Ports** tab at the bottom, find port 3000, and click the globe icon 🌐

### Step 4: Make Port Public (for sharing download links)
1. Go to the **Ports** tab at the bottom of VS Code
2. Right-click on port 3000
3. Select **Port Visibility** → **Public**
4. Now your download links can be accessed by anyone with the URL

### Step 5: Use the Downloader
1. Paste your download URL in the input field
2. Click **Download**
3. Watch the real-time progress
4. Once complete, click the download link to get your file
5. Share the Codespace URL with others for faster downloads!

## Local Installation

```bash
npm install
npm start
```

The server will start on port 3000 (or the PORT environment variable).

## How It Works
1. Paste a direct download URL in the web interface
2. The server downloads the file with real-time progress updates
3. Once complete, you get a new download link hosted on your server
4. Share this new link for faster downloads

## Screenshot

![Mirror Downloader UI](https://github.com/user-attachments/assets/7a6d7873-4f7a-41a7-9f05-5cd07c05644d)
