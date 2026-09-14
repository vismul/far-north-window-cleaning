# Instagram skills

Thirteen `ig-*` skills from https://github.com/Jakeschincariol/instagram-agent-skill
(MIT, licence kept as `LICENSE-instagram-agent-skill`). They write Instagram
content - reels, carousels, stories, captions, comments, replies, DMs - and
plan and audit the account. Nothing posts anywhere. There is no account
connection and no API key. They write, you post.

They live here rather than in `~/.claude/skills/` so they survive a fresh
machine and a fresh Claude session.

They are not part of the website. GitHub Pages ignores dotfile folders, so
`.claude/` is never published.

## Voice

Every skill reads `~/.claude/instagram/voice.md`. The tracked copy is
`instagram/voice.md` in this repo. On a new machine:

```bash
mkdir -p ~/.claude/instagram && cp instagram/voice.md ~/.claude/instagram/
```

It is currently drafted from the website copy and has TODOs in it. Sending
Claude three real reels and saying "rewrite my voice.md from these" is worth
more than anything else in this folder.
