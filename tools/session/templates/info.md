<!-- tpm:if !session.enabled -->
tpm-session is disabled by config (`session.enabled: false`) — say "session lifecycle disabled by config" and do nothing else.
<!-- tpm:endif -->
<!-- tpm:if session.enabled -->
## `tpm-session info` (writes nothing)

If `tpm session current --state` returns a `tracks` array (the session has several parallel tracks), list EVERY track before the footer, one line each: letter, state (`live` / `sealed-self` / `sealed-marker` / `unreadable`), owner (8 chars), opened, last write; mark the one with `mine: true` as yours. `tpm session doctor` checks them all and names any stuck track.

<!-- tpm:inject footer -->

<!-- tpm:endif -->
