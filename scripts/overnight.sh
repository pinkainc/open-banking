#!/usr/bin/env bash
# Run the handoff chain unattended, strictly one session at a time.
# Each round takes the newest handoff, runs it as a fresh `claude -p` session
# (which ends with /wrap-up and writes the next handoff), then checks the result.
# Any failed check stops the chain, so no session builds on a broken base.
#
#   scripts/overnight.sh [max-sessions]     (default 1)
#
# Logs and the run summary go to .rec/overnight/<timestamp>/.
set -uo pipefail
cd "$(dirname "$0")/.."

MAX=${1:-1}
MODEL=${OVERNIGHT_MODEL:-opus}
HANDOFFS="$HOME/.claude/handoffs/open-banking"
STOP_FILE=.rec/overnight-stop
RUN=.rec/overnight/$(date +%Y-%m-%d-%H%M)
mkdir -p "$RUN"
SUMMARY="$RUN/summary.md"

PREAMBLE='AUTONOMNI NOĆNI RAD. Korisnik spava i ne može odgovarati. Pravila za ovu sesiju:
- Subagente pokreći STROGO JEDNOG PO JEDNOGA: čekaj da prethodni završi prije sljedećeg. Nikad paralelno, nikad isolation: worktree, nikad Workflow.
- Ne koristi Monitor, ScheduleWakeup, CronCreate ni AskUserQuestion.
- Odluku koja je inače korisnikova: odaberi konzervativnu opciju, zapiši je u docs/decisions.md s oznakom "(noćni rad, potvrditi)" i dodaj stavku u TODO.md pod "Za pregled ujutro".
- Ako paket ne možeš napraviti bez čovjeka (sandbox certifikat, odgovori iz sandboxa, pristup izvana): napravi što možeš, zatim upiši razlog u .rec/overnight-stop i svejedno završi s wrap-up.
- Ako je sljedeći paket u planu S8 (conformance protiv sandboxa), u handoffu ga pripremi, ali upiši razlog u .rec/overnight-stop.
- Prije wrap-upa `npm run check` mora prolaziti.
- Na kraju obavezno pozovi Skill tool sa skill: "wrap-up".
- Zadnja poruka: najviše 10 redaka — što je gotovo, broj testova, otvorena pitanja.

--- HANDOFF ---
'

note() { echo "$*" | tee -a "$SUMMARY"; }
notify() { osascript -e "display notification \"$1\" with title \"open-banking overnight\"" 2>/dev/null || true; }
newest() { ls -t "$HANDOFFS"/*.md 2>/dev/null | head -1; }
fail() { note "STOP: $*"; notify "STOP: $*"; exit 1; }

rm -f "$STOP_FILE"
note "# Overnight $(date '+%F %T'), max $MAX, model $MODEL"

for ((i = 1; i <= MAX; i++)); do
  H=$(newest)
  [ -n "$H" ] || fail "nema handoffa u $HANDOFFS"
  [ -z "$(git status --porcelain)" ] || fail "git nije čist prije sesije $i"
  HEAD0=$(git rev-parse --short HEAD)
  note "" "## Sesija $i: $(basename "$H") (od $HEAD0, $(date +%T))"

  OUT="$RUN/session-$i.json"
  claude -p "$PREAMBLE$(cat "$H")" --model "$MODEL" --permission-mode bypassPermissions \
    --output-format json > "$OUT" 2> "$RUN/session-$i.err"
  SID=$(jq -r '.session_id // empty' "$OUT" 2>/dev/null)

  # Usage limit mid-session: wait for the reset and resume the same session (max 3x).
  for ((r = 1; r <= 3; r++)); do
    grep -qiE "usage limit|rate.?limit|limit reached" "$OUT" "$RUN/session-$i.err" || break
    [ -n "$SID" ] || fail "limit potrošen, a session_id nepoznat (sesija $i)"
    note "limit potrošen ($(date +%T)), čekam 60 min pa nastavljam $SID"
    sleep 3600
    claude -p "Limit je prošao. Nastavi točno gdje si stao, po istim pravilima, i završi s wrap-up." \
      --resume "$SID" --model "$MODEL" --permission-mode bypassPermissions \
      --output-format json > "$OUT" 2> "$RUN/session-$i.err"
  done

  note "$(jq -r '"trajanje \((.duration_ms // 0) / 60000 | floor) min, \(.num_turns // "?") poteza, ~$\(.total_cost_usd // "?") API-ekviv., is_error=\(.is_error)"' "$OUT" 2>/dev/null)"
  note '```'; jq -r '.result // "(nema rezultata)"' "$OUT" 2>/dev/null | tee -a "$SUMMARY" >/dev/null; note '```'

  [ "$(jq -r '.is_error' "$OUT" 2>/dev/null)" != "true" ] || fail "sesija $i završila s greškom (vidi $OUT)"
  [ "$(newest)" != "$H" ] || fail "sesija $i nije napisala novi handoff (wrap-up se nije dogodio)"
  [ -z "$(git status --porcelain)" ] || fail "sesija $i ostavila necommitane promjene"
  [ "$(git rev-parse --short HEAD)" != "$HEAD0" ] || fail "sesija $i nije ništa commitala"
  npm run check > "$RUN/check-$i.log" 2>&1 || fail "npm run check pada nakon sesije $i (vidi $RUN/check-$i.log)"
  note "check: $(grep -E '^ℹ (pass|fail|skipped)' "$RUN/check-$i.log" | tr '\n' ' ')"
  [ ! -f "$STOP_FILE" ] || fail "sesija $i traži čovjeka: $(cat "$STOP_FILE")"
done

note "" "Gotovo: $MAX sesija, $(date '+%F %T'). Sljedeći handoff: $(basename "$(newest)")"
notify "gotovo, $MAX sesija"
