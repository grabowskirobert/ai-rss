# Zasady pracy w tym repozytorium

- Zmiany wypychaj od razu na `main` (fast-forward, po `git fetch origin main`
  i przebudowie na aktualny `main`). Bez PR-ów, chyba że właściciel poprosi.
  Nocny przebieg generujący wydanie bierze kod z `main`, więc zmiana tylko
  na gałęzi nie działa.
- Wydanie jest praktycznie wyłącznie słuchane (odsłuch): każda zmiana treści
  ma sens tylko wtedy, gdy działa w nagraniu.
