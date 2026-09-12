/* ===========================================================================
   Firebase keys for sync.

   Replace the two PASTE_... values below with the ones from your own Firebase
   project, then save the file. Every tool - on the PC and on the phone - picks
   them up the next time it opens.

   Step-by-step instructions are in SETUP-SYNC.md, in this same folder.

   Is it safe to have these in a file?
   -----------------------------------
   Yes. The API key is not a password - it only says which project to talk to.
   What actually guards the data is the Firestore rule you paste in during
   setup, which allows nobody through except the one signed-in account. Google
   publishes these same keys in every Firebase web app.
   =========================================================================== */
window.FNWC_FIREBASE = {
  apiKey:    "AIzaSyDJaOQzfD2QN4XHnmQpJXP0DB-lEcUScr8",
  projectId: "fnwc-95348"
};
