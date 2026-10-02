# Prayer Tracker (phase 1)

Files:
- index.html: the whole app (HTML, CSS and JS)
- manifest.webmanifest: makes it installable
- sw.js: service worker (offline use and notifications)
- icons/: app icons (icon.svg is the source)
- splash.jpg: the painting shown on the splash screen (cropped to keep the face in view).

Data is stored in localStorage under the key "prayerTracker.v1":
{ version, settings: { prayers: [{id,name,time,notify}], updatedAt },
  days: { "YYYY-MM-DD": { done: { morning: "<ISO time ticked>" }, updatedAt } },
  meta: { firstDay, notified } }
Every record carries updatedAt, so phase 2 sync can use last-write-wins.

When you upload changed files, bump VERSION in sw.js so the phone picks them up.
