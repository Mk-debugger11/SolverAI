# Solver.Ai — Chrome Extension (MERN Stack)

See [quiz solver features and testing](docs/MCQ_EFFICIENCY.md) for numerical answers, request pacing, answer caching, token budgets and the current test/reload workflow.

See [assignment setup and supported actions](docs/ASSIGNMENTS.md) for automatic coding and Jupyter solving, unfinished-assignment batches, request limits and recovery.

An automated quiz and assignment solver and DOM extractor Chrome Extension (Manifest V3), built with React, Vite, Express, and Groq Cloud. MongoDB is optional for capture history.

---

##  Tech Stack

- **Frontend / Extension**: React 18, Vite, Chrome Extensions API (Manifest V3: `activeTab` & `scripting`)
- **Backend API**: Node.js & Express (`http://localhost:5001/api`)
- **Database**: MongoDB via Mongoose (`mongodb://127.0.0.1:27017/dom_fetcher`)

---

## 📁 Project Structure

```
chrome extension/
├── backend/
│   ├── models/
│   │   └── DomRecord.js       # Mongoose Schema (url, title, html, elementCount, sizeBytes)
│   ├── .env                   # PORT=5001 & MONGO_URI
│   ├── package.json
│   └── server.js              # Express REST API (health, save, list, delete)
├── extension/
│   ├── public/
│   │   ├── manifest.json      # Chrome Manifest V3 configuration
│   │   └── icons/             # 16px, 48px, 128px extension icons
│   ├── src/
│   │   ├── App.jsx            # React popup UI (DOM capture, preview, DB save, history)
│   │   ├── index.css          # Sleek modern styling
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── dist/                  # Production-ready unpacked extension folder
└── package.json
```

---

## 🚀 Quick Start Guide

### Step 1: Start the Backend Server

MongoDB is optional for quiz and assignment generation. Start it if you want to save DOM captures and use their history:
```bash
# Check if MongoDB is running (already running if on default 27017)
brew services start mongodb-community
```

Start the Express backend:
```bash
npm run start:server
# or for auto-reloading dev mode:
npm run dev:server
```
The server starts on **`http://localhost:5001`**. If MongoDB is unavailable, solver routes remain usable and saved DOM history is unavailable.

---

### Step 2: Load the Extension into Google Chrome

1. Open Google Chrome and navigate to:
   ```
   chrome://extensions/
   ```
2. Enable **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the **`extension/dist`** folder inside this project directory.
5. The **Solver.Ai** extension icon will appear in your extensions bar! Pin it for quick access.

---

### Step 3: Use the Extension

1. Navigate to any webpage with multiple-choice questions or radio forms (e.g. Google Forms, quizzes, surveys, exam portals).
2. Click the **Solver.Ai** extension icon in your Chrome toolbar.
3. Click **⚡ Fetch & Extract Radio Containers**:
   - Automatically finds all `<input type="radio">` elements on the page.
   - Selects the parent `<div>` container holding each question and all its options.
   - Extracts:
     - The **Question Text** (from headings, legends, or container prompt).
     - All **Options** (radio values, label texts, and checked state).
     - The exact **Parent Container `<div>` HTML** (`outerHTML`).
4. In the Popup UI:
   - **View Questions**: Each question card displays the prompt, question ID, and selectable options.
   - **📋 Copy Question Button**: Located on each question card. Copies the complete JSON object for that specific question (including all DOM attributes of the question element, container element, and all options with their attributes and IDs).
   - **Dynamic DOM Click (`👆 Click`)**: Click the `👆 Click` button next to any option to dynamically scroll to and click it on the live webpage!
   - **Inspect / Copy Div HTML**: Expand to inspect the raw parent `<div>` HTML or copy it with one click.
   - **Copy JSON**: Copy structured `{ questionId, question, options }` data directly to clipboard.
   - **Save to MongoDB**: Persists the selected question containers and structured question data to MongoDB!
   - **Toggle Full DOM**: Easily switch between "Radio Containers Only" and "Full Page DOM".
5. Click **Saved DB** tab to view your saved captures and question history.

---

## 🛠 Rebuilding the Extension (After edits)

If you modify files inside `extension/src/`:
```bash
npm run build:extension
```
Then simply click the **Refresh (↻)** button on the extension card in `chrome://extensions/`.

---

## 🌐 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check & MongoDB connection status |
| `POST` | `/api/dom` | Save page capture `{ url, title, html, elementCount, sizeBytes }` |
| `GET` | `/api/dom` | List recent saved captures (excludes large HTML body for speed) |
| `GET` | `/api/dom/:id` | Get full record including full HTML |
| `DELETE` | `/api/dom/:id` | Delete record by ID |
