#!/bin/bash

cd "$(dirname "$0")" || exit 1

python3 -m http.server 8000 --directory studio

open http://localhost:8000/index.html