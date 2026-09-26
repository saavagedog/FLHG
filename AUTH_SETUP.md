# Project Fishk auth setup

## 1) Update launcher env

Open .env and set:

```env
VITE_BACKEND_URL=http://127.0.0.1:3552
VITE_ENABLE_API=true
```

## 2) Start the auth server

In CMD:

```cmd
cd /d "C:\Users\rayan\Documents\Project Fishk\OGFN-Launcher-skids-TEST\OGFN-Launcher-skids-TEST"
set MONGO_URI=mongodb://127.0.0.1:27017/FISHKY
set PORT=3552
node backend-auth-server.js
```

## 3) Create a valid user

Use MongoDB to create one test user with a Discord ID and a hashed password.

Example Mongo document:

```json
{
  "email": "player@example.com",
  "username": "Fishky",
  "passwordHash": "$2b$10$examplehash",
  "discordId": "123456789012345678",
  "discordLinked": true,
  "avatarHash": "abc123",
  "banned": false
}
```

## 4) Login contract

POST to http://127.0.0.1:3551/api/auth/login

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
    "avatarHash": "abc123"
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
