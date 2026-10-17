import os

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8004"))
    uvicorn.run("services.rents.app:app", host=os.environ.get("HOST", "0.0.0.0"), port=port)


if __name__ == "__main__":
    main()
