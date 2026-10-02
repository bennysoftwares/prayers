# Prayer Tracker

Files:
- index.html: the whole app (HTML, CSS and JS)
- manifest.json: makes it installable (name, colours, icons)
- sw.js: service worker (offline use and notifications). Bump VERSION on every update.
- splash.jpg: the painting on the splash screen
- header.jpg: the wide sunset-church photo at the top of every screen
- icons/: apple-touch-icon.png (180), icon-192.png, icon-512.png, icon-maskable-512.png, icon-1024.png

Data is stored in localStorage under the key "prayerTracker.v1":
{ version, settings: { prayers: [{id,name,time,notify}], theme, updatedAt },
  days: { "YYYY-MM-DD": { done: { morning: "<ISO time ticked>" }, updatedAt } },
  meta: { firstDay, notified } }
Every record carries updatedAt, so phase 2 sync can use last-write-wins.
