# JellyGram documentation

[JellyGram](../README.md) is a self-hosted Telegram bot and Mini App that
uploads and organises personal media into a Jellyfin server you run yourself,
giving each person their own private Jellyfin library.

This directory is the reference material. Start with the
[Quick start](../README.md#quick-start) in the main README; come here when you
need the detail.

## Setting it up

| I want to… | Read |
| --- | --- |
| Install it and get the first upload working | [Quick start](../README.md#quick-start) |
| Understand every setting in `.env` | [configuration.md](configuration.md) |
| Create the database, run migrations, take backups | [database.md](database.md) |
| Create the Telegram bot, find IDs, register the Mini App | [telegram.md](telegram.md) |
| Create the Jellyfin API key and understand the isolation model | [jellyfin.md](jellyfin.md) |
| Reach the server over LAN, VPN or the internet, and get HTTPS for the Mini App | [networking.md](networking.md) |
| Send files larger than Telegram's 20 MB bot limit | [large-files.md](large-files.md) |

## Running it

| I want to… | Read |
| --- | --- |
| Deploy with systemd, a reverse proxy and nightly backups | [../deploy/README.md](../deploy/README.md) |
| Understand the processes, the queue and what happens on restart | [architecture.md](architecture.md) |
| Know what the Mini App may ask for and how it authenticates | [miniapp.md](miniapp.md) |
| Call the HTTP API | [api.md](api.md) |
| Work out why something is not behaving | [troubleshooting.md](troubleshooting.md) |

## Contributing and trust

| I want to… | Read |
| --- | --- |
| Understand the threat model and the controls | [security.md](security.md) |
| Report a vulnerability privately | [../SECURITY.md](../SECURITY.md) |
| Run the test suites and understand how they isolate themselves | [testing.md](testing.md) |
| Submit a change | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| See what shipped and when | [../CHANGELOG.md](../CHANGELOG.md) |
