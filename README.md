# Recipe Book

A static web app for storing and viewing recipes. You sign in with Google, recipes are saved to a **Recipe Book** folder in your Google Drive (`recipes.json` plus photos), and you can download every recipe as a PDF book with a clickable table of contents.

There's no server or database, so it runs for free on GitHub Pages.

## 1. Create a Google OAuth client ID (one-time, free)

1. Go to https://console.cloud.google.com/ and create a project, for example "Recipe Book".
2. Under **APIs & Services → Library**, enable the **Google Drive API**.
3. Under **APIs & Services → OAuth consent screen**, choose **External** and fill in the app name and your email.
   - Scopes: `openid`, `email`, `profile`, `.../auth/drive.file`. None of these needs Google verification.
   - Either add yourself (and anyone else) under **Test users**, or click **Publish app**.
4. Under **APIs & Services → Credentials**, choose **Create credentials → OAuth client ID → Web application**.
   - Authorized JavaScript origins:
     - `https://<your-github-username>.github.io`
     - `http://localhost:8000` (for local testing)
5. Copy the client ID into `config.js`.

## 2. Host it free on GitHub Pages

1. Create a public GitHub repo, for example `recipe-book`, and push these files to it.
2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. The site goes live at `https://<your-github-username>.github.io/recipe-book/`.

## Run locally

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Notes

- Each Google account gets its own recipe book in its own Drive. The app can only see files it created (`drive.file` scope).
- Sign-in lasts about an hour. After that, the app asks you to sign in again.
- Deleted recipes' photos are moved to your Drive trash, not permanently deleted.
