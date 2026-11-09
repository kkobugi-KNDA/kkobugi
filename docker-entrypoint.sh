#!/bin/sh
set -eu

# 런타임에 마운트되는 디스크 안에 앱 전용 폴더만 새로 만든다.
# 기존 폴더·DB·CSV·모델의 소유권이나 내용은 바꾸지 않는다.
storage_directory=/var/data/kkobugi
if [ -L "$storage_directory" ] || { [ -e "$storage_directory" ] && [ ! -d "$storage_directory" ]; }; then
    echo "App storage must be a directory: $storage_directory" >&2
    exit 1
fi

if [ "$(id -u)" = 0 ]; then
    if [ ! -d "$storage_directory" ]; then
        install -d -m 0700 -o app -g app "$storage_directory"
    fi
    if ! gosu app test -w "$storage_directory"; then
        echo "App storage is not writable by app; check ownership before starting." >&2
        exit 1
    fi
    exec gosu app "$@"
fi

if [ ! -w "$storage_directory" ]; then
    echo "App storage is not writable by the current user." >&2
    exit 1
fi
exec "$@"
