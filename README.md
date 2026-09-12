# Far North Window Cleaning

The public website for Far North Window Cleaning, Cairns.

`index.html` is the whole site - one self-contained file. No build step, no
dependencies, no server. The logo is embedded in the file itself, so it works
even with no internet connection.

Served by GitHub Pages.

## Editing it

Open `index.html` in a text editor, or ask Claude Code to change it. There is
nothing to compile or deploy - pushing to `main` publishes it.

## `/os/` - the phone app

`os/index.html` is the mobile version of the business tools: jobs, the diary,
leads, customers, quoting, the reply desk and receipts, laid out for a phone.
It publishes to `farnorthwindowcleaning.com.au/os/` so it can be added to the
home screen.

It is not linked from the site, it is marked no-index, and `robots.txt` keeps
it out of search. None of that is what protects it - the data lives in
Firestore behind a sign-in, so the page is empty to anyone who cannot log in.

It syncs with the desktop tools. Setup is in `SETUP-SYNC.md` in the parent
folder.

## What is deliberately NOT in here

The full desktop tools (Window OS, the Diary, the Job Assistant, the Reply
Desk, the invoice maker and the books) live outside this folder and are not
published. They are for internal use only. The phone app above is a cut-down
view of the same data, not a copy of those pages.
