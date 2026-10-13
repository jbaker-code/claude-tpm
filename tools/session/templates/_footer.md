**Footer (the LAST thing every `tpm-session` mode prints — an unmistakable "you are in session NNN" line).** Resolve and print, in order:
1. Current session number + track (e.g. `0123b`; fields `number` and `track` of `tpm session current --state`) + folder path ("no session open yet" if `state: not-opened`; "open by another instance - no track of yours yet" if `state: foreign-open`).
2. Whether YOUR track's record exists for it yet (`session-NNNN.json` + derived `.md` on track a, `session-NNNN-<letter>.json` + `.md` on track b..z), and roughly when it was last modified.
3. Total session count (`ls <sessions-dir>/session-*/ | wc -l`-shaped over the resolved sessions dir, or read `tpm session export`'s listing).
4. The real Claude Code sessionId if `$CLAUDE_CODE_SESSION_ID` is readable (best-effort, diagnostic-only, not load-bearing).
