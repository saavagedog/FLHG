# Reload Backend Auth Flow for Project Fishk

This is a copy-paste example for a Node + Express + MongoDB backend that matches the login flow you want.

## Use it with:
- MongoDB
- Discord bot
- Project Fishk launcher

## Required packages

```bash
npm install express mongoose bcryptjs
```

## Environment

```bash
MONGO_URI=mongodb://localhost:27017/projectfishk
PORT=3551
```

## API endpoints

### POST /api/auth/login
Request body:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Success response:
```json
{
  "success": true,
  "user": {
    "email": "user@example.com",
    "username": "Fishky",
    "discordId": "123456789012345678",
    "avatarHash": "abc123"
  }
}
```

Failure responses:
```json
{
  "success": false,
  "message": "Wrong credentials or Discord account not linked."
}
```

### POST /api/auth/register
Request body:
```json
{
  "email": "user@example.com",
  "username": "Fishky",
  "password": "password123",
  "discordId": "123456789012345678"
}
```

### POST /api/auth/link-discord
Request body:
```json
{
  "email": "user@example.com",
  "discordId": "123456789012345678",
  "avatarHash": "abc123"
}
```

## Important rule
Only allow login when:
- email exists in MongoDB
- password hash matches
- user.discordLinked === true
- user.discordId exists

That is the exact rule you described.
