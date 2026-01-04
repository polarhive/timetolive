# TimeTabLe (╯°□°)╯︵ ┻━┻

Simple Flask app to parse PESU timetables into usable outputs `json` `.ics` and provide a simple web frontend for comparing timetables.

[uv](https://docs.astral.sh/uv/getting-started/installation)

```sh
uv run main.py
```

### API

```sh
curl -X POST "https://timetolive.vercel.app/api/timetable" \
  -H "Content-Type: application/json" \
  -d '{"srn":"PES2UG23CS001","password":"your_password"}'
```

```sh
curl -s "https://timetolive.vercel.app/api/timetable/all"
```

```sh
curl -s "https://timetolive.vercel.app/api/timetable/ec_23cs_6A"
```

```sh
curl -L "https://timetolive.vercel.app/api/timetable/ec_23cs_6A/ical?start=2026-01-12"
```

## Notes

- Saving timetables to `static/timetables/` is disabled by default; enable it with `TIMETABLES_SAVE=1`.
- I dispatch new timetables to this GitHub repo, set `GITHUB_REPO` and `GITHUB_TRIGGER_TOKEN`

## Contributions

Feel free to open issues and PRs for improvements and feature requests.
