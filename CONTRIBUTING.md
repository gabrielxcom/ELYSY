# Contributing to Eliz's LRC Generator

First off — thank you for wanting to contribute! ❤️
This project exists to free musicians from paywalled lyrics tools.

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Code** — bug fixes, features, performance
- **Documentation** — guides, typos, translations
- **Testing** — try it on your songs, report edge cases
- **Ideas** — open an issue with your use case

## Getting started

1. Fork the repo and clone it.
2. Set up a dev environment (see README → Manual Installation).
3. Create a branch: `git checkout -b feature/my-feature`
4. Make your changes.
5. Test them (see below).
6. Commit with a clear message, push, open a Pull Request.

## Development setup

```bash
python -m venv venv
source venv/bin/activate        # or venv\Scripts\activate on Windows
pip install torch==2.8.0+cu128 torchaudio==2.8.0+cu128 torchvision==0.23.0+cu128 --index-url https://download.pytorch.org/whl/cu128
pip install -r backend/requirements.txt
python backend/app.py           # → http://127.0.0.1:8765