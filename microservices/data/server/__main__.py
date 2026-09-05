"""``python -m server`` — serve the Living Score API."""

import os

import uvicorn


def main() -> None:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
