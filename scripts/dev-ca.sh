#!/usr/bin/env bash
# A throwaway certificate authority for local use: one CA, a server certificate for
# localhost and client certificates whose subject serialNumber is the registration
# code of an emulator customer (that is how the server tells clients apart).
#
#   scripts/dev-ca.sh                    # CA + server + the three demo clients, in .certs/
#   scripts/dev-ca.sh client NAME CODE   # one more client certificate, e.g. acme 55500001
#   CERTS_DIR=/tmp/x scripts/dev-ca.sh   # somewhere else
#
# The CA is reused when it exists. Keys are unencrypted: never use these anywhere real.
set -euo pipefail
dir=${CERTS_DIR:-"$(cd "$(dirname "$0")/.." && pwd)/.certs"}
mkdir -p "$dir"
cd "$dir"

ca() {
  [ -f ca.crt ] && return
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout ca.key -out ca.crt \
    -subj "/C=EE/O=open-banking dev CA/CN=open-banking dev CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}

server() {
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 \
    -extfile server.ext -out server.crt 2>/dev/null
  rm -f server.csr server.ext
}

# client NAME CODE: subject serialNumber carries the registration code.
client() {
  local name=$1 code=$2
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" \
    -subj "/C=EE/O=$name/CN=$name/serialNumber=$code" 2>/dev/null
  printf 'extendedKeyUsage=clientAuth\n' > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 \
    -extfile "$name.ext" -out "$name.crt" 2>/dev/null
  rm -f "$name.csr" "$name.ext"
  echo "client $name (serialNumber=$code): $dir/$name.crt $dir/$name.key"
}

ca
if [ "${1:-}" = client ]; then
  [ $# -eq 3 ] || { echo "usage: $0 client NAME CODE" >&2; exit 2; }
  client "$2" "$3"
  exit 0
fi
server
# The demo customers of config/dev-seed.json.
client client1 12340001
client client2 12340002
client provider 10000001
# A certificate from the right CA whose code no customer has: answers 403.
client stranger 99999999
echo "CA: $dir/ca.crt  server: $dir/server.crt"
