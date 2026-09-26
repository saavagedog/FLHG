# Project Fishk auth setup

## 1) Update launcher env

Open .env and set:

```env
VITE_BACKEND_URL=http://127.0.0.1:3552
VITE_ENABLE_API=true
```

For a launcher installed on another computer, replace `127.0.0.1` with the publicly reachable backend host and use HTTPS. Loopback addresses only reach services on the same computer.

## 2) Start the auth server

In CMD:

```cmd
cd /d "C:\Users\rayan\Documents\Project Fishk\OGFN-Launcher-skids-TEST\OGFN-Launcher-skids-TEST"
set MONGO_URI=mongodb://127.0.0.1:27017/FISHKY
set PORT=3552
set ADMIN_EMAILS=admin@example.com
node backend-auth-server.js
```

`ADMIN_EMAILS` is a comma-separated server-side allowlist. You can instead mark an existing user as admin in MongoDB by setting `isAdmin: true` or `role: "admin"`. Never put an admin password in the launcher configuration.

## 3) Create a valid user

Use MongoDB to create one test user with a Discord ID and a hashed password.

Example Mongo document:

```json
{
  "email": "player@example.com",
  "username": "Fishky",
  "password": "$2b$10$examplehash",
  "discordId": "123456789012345678",
  "discordLinked": true,
  "isAdmin": false,
  "role": "user",
  "avatarHash": "abc123",
  "banned": false
}
```

## 4) Login contract

POST to http://127.0.0.1:3552/api/auth/login

Body:

```json
{
  "email": "player@example.com",
  "password": "yourPassword123"
}
```

Success:

```json
{
  "success": true,
  "user": {
    "email": "player@example.com",
    "username": "Fishky",
    "discordId": "123456789012345678",
    "avatarHash": "abc123",
    "isAdmin": false
  }
}
```

Failure:

```json
{
  "success": false,
  "message": "Wrong credentials or Discord account not linked."
}
```

## 5) Important

The host account from Reload-Backend is not a normal launcher account and has no Discord ID, so it should be rejected by design.

## 6) Admin news and media

Admin accounts can publish announcements from the launcher's News tab. The API checks the account against the server-side `ADMIN_EMAILS` allowlist or the account's MongoDB `isAdmin`/`role` fields; a client-side flag alone cannot publish.

The feed is public at `GET /api/news`. Admin publishing uses `POST /api/news`. Uploaded JPG, PNG, WebP, GIF, MP4, and WebM media is limited to 50 MB and stored under `data/news-media` by default; set `NEWS_MEDIA_DIRECTORY` to a persistent folder on the backend host if needed. News metadata is stored in the `launcherNews` MongoDB collection.

After granting admin access, restart the auth server and sign out/in in the launcher so the login response refreshes the user's admin flag. For shared announcements, deploy this API and its media directory on a host reachable by every launcher user, and configure the launcher to use that HTTPS backend URL.
