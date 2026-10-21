# Study Desk — daily study tracker

Add PDFs, YouTube videos, HTML files, Word (.docx) files or any webpage, give each one a daily study time,
and Study Desk shows it on your **Today** list until it's finished — opening exactly where you stopped.

- **YouTube** resumes at the second you left off; **PDF** at the page; **HTML / Word** at the scroll position.
- Each card shows progress (e.g. *33% · Resume at 20:00 / 1:00:00 · +33% today*).
- Only real study time is counted: videos while playing, documents while you're active (stops after 3 idle minutes).
- **Stats**: today's time, last 14 days, streak, time per item.
- 🔔 Reminders at the scheduled time while the site is open in a tab.
- Everything is stored in your browser (IndexedDB). Use ⋮ → **Export / Import backup** to move it to another device.

Webpages: many sites don't allow being shown inside another site — use *Open in new tab* and set progress with the slider,
or give a reading time so progress fills up as you spend time.

Run locally (YouTube needs http, not a double-clicked file):

```bash
python3 -m http.server 8000
```
