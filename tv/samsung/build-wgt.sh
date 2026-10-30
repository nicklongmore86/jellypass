#!/usr/bin/env bash
# Builds the JellyPass build of Jellyfin's Samsung (Tizen) app, dist/samsung/Jellyfin.wgt (docs/tv-addon.md, "The
# Samsung app"): Jellyfin web and jellyfin-tizen at the commits in tv/samsung/pins.env, built in the pinned Node image,
# with the JellyPass loader added to Jellyfin web's page, then packaged and signed in the pinned Tizen image with its
# built-in 'dev' profile. It never talks to a TV.
#
#   JELLYPASS_TV_HOSTS='media.example.com' tv/samsung/build-wgt.sh
#
# JELLYPASS_TV_HOSTS: the household hosts the loader may load the add-on from (exact names, or one * in the first
# label), separated by commas. Needs docker, git, python3 and the repository's dependencies (pnpm install).
# JELLYPASS_SAMSUNG_CACHE (default ~/.cache/jellypass-samsung) holds the sources, JELLYPASS_SAMSUNG_OUT (default
# dist/samsung) the result.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
# shellcheck source=pins.env
source "${here}/pins.env"
hosts="${JELLYPASS_TV_HOSTS:?Set JELLYPASS_TV_HOSTS to the household hosts, e.g. media.example.com}"
cache="${JELLYPASS_SAMSUNG_CACHE:-${HOME}/.cache/jellypass-samsung}"
out="${JELLYPASS_SAMSUNG_OUT:-${repo}/dist/samsung}"
web="${cache}/jellyfin-web"
tizen="${cache}/jellyfin-tizen"
user="$(id -u):$(id -g)"

# Checks the hosts before anything slow runs.
node "${here}/build-loader.mjs" --hosts "${hosts}" --check

# A clean checkout of exactly `commit` (fetched by `ref`) in `dir`.
checkout() {
    local dir="$1" url="$2" ref="$3" commit="$4"
    if [[ ! -d "${dir}/.git" ]]; then
        git init -q "${dir}"
        git -C "${dir}" remote add origin "${url}"
    fi
    git -C "${dir}" fetch -q --depth 1 origin "${ref}"
    git -C "${dir}" checkout -q --detach FETCH_HEAD
    git -C "${dir}" reset -q --hard
    git -C "${dir}" clean -q -ffdx
    local head
    head="$(git -C "${dir}" rev-parse HEAD)"
    [[ "${head}" == "${commit}" ]] || { echo "${url} ${ref} is ${head}, not the pinned ${commit}" >&2; exit 1; }
}

mkdir -p "${cache}"
echo "Jellyfin web ${JELLYFIN_WEB_TAG} (${JELLYFIN_WEB_COMMIT})"
checkout "${web}" "${JELLYFIN_WEB_REPO}" "refs/tags/${JELLYFIN_WEB_TAG}" "${JELLYFIN_WEB_COMMIT}"
echo "jellyfin-tizen ${JELLYFIN_TIZEN_COMMIT}"
checkout "${tizen}" "${JELLYFIN_TIZEN_REPO}" "${JELLYFIN_TIZEN_COMMIT}" "${JELLYFIN_TIZEN_COMMIT}"

# Jellyfin web's production build, as jellyfin-tizen's README builds it (system fonts, to keep the app small).
docker run --rm --user "${user}" -e HOME=/tmp -e USE_SYSTEM_FONTS=1 -v "${web}:/src" -w /src "${NODE_IMAGE}" \
    sh -c 'npm ci --no-audit --no-fund && npm run build:production'
# jellyfin-tizen's step: its install runs gulp, which copies Jellyfin web's dist into www/ and adds tizen.js to the page.
docker run --rm --user "${user}" -e HOME=/tmp -e JELLYFIN_WEB_DIR=/web -v "${web}/dist:/web:ro" -v "${tizen}:/src" -w /src \
    "${NODE_IMAGE}" npm ci --no-audit --no-fund

# The one JellyPass change: the loader, and its tag in the page.
node "${here}/build-loader.mjs" --hosts "${hosts}" --www "${tizen}/www"

app_id="$(sed -n 's/.*<tizen:application id="\([^"]*\)".*/\1/p' "${tizen}/config.xml")"
[[ "${app_id}" == "${TIZEN_APP_ID}" ]] || { echo "config.xml names ${app_id}, not ${TIZEN_APP_ID}" >&2; exit 1; }

# Packaged from a copy inside the Tizen image, offline, and signed with its 'dev' profile; jellyfin-tizen's README
# leaves the same files out.
rm -rf "${out}"
mkdir -p "${out}"
docker run --rm --network none -v "${tizen}:/in:ro" -v "${out}:/out" --entrypoint /bin/bash "${TIZEN_IMAGE}" -c '
    set -euo pipefail
    cp -r /in /tmp/app
    cd /tmp/app
    tizen build-web -e ".*" -e gulpfile.babel.js -e README.md -e "node_modules/*" -e "package*.json" -e "yarn.lock" -- /tmp/app
    tizen package -t wgt -s dev -o /tmp/package -- /tmp/app/.buildResult
    cp /tmp/package/Jellyfin.wgt /out/Jellyfin.wgt
    chown '"${user}"' /out/Jellyfin.wgt'

wgt="${out}/Jellyfin.wgt"
# Checks the package holds what it should, and records what it was built from.
python3 -I - "${wgt}" "${TIZEN_APP_ID}" > "${out}/build-info.txt" <<'EOF'
import base64, hashlib, re, subprocess, sys, zipfile
path, app_id = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(path) as wgt:
    names = set(wgt.namelist())
    for name in ('config.xml', 'author-signature.xml', 'signature1.xml', 'www/index.html', 'www/jellypass-loader.js', 'tizen.js'):
        assert name in names, f'{name} is missing from the package'
    assert f'<tizen:application id="{app_id}"' in wgt.read('config.xml').decode(), 'config.xml has another app id'
    page = wgt.read('www/index.html').decode()
    assert page.count('data-jellypass-loader') == 1, 'the page does not have exactly one loader tag'
    loader = wgt.read('www/jellypass-loader.js')
    signature = wgt.read('author-signature.xml').decode()
certificate = base64.b64decode(''.join(re.search(r'<X509Certificate>\s*([^<]+)</X509Certificate>', signature).group(1).split()))
subject = subprocess.run(['openssl', 'x509', '-inform', 'der', '-noout', '-subject'], input=certificate, capture_output=True, check=True).stdout.decode().strip()
print(f'wgt sha256: {hashlib.sha256(open(path, "rb").read()).hexdigest()}')
print(f'app id: {app_id}')
print(f'loader sha256: {hashlib.sha256(loader).hexdigest()}')
print(f'author certificate: {subject}, sha256 {hashlib.sha256(certificate).hexdigest()}')
EOF
{
    echo "hosts: ${hosts}"
    echo "jellyfin-web: ${JELLYFIN_WEB_TAG} ${JELLYFIN_WEB_COMMIT}"
    echo "jellyfin-tizen: ${JELLYFIN_TIZEN_COMMIT}"
    echo "node image: ${NODE_IMAGE}"
    echo "tizen image: ${TIZEN_IMAGE} (profile dev)"
    echo "jellypass: $(git -C "${repo}" rev-parse HEAD)$([[ -z "$(git -C "${repo}" status --porcelain -- tv/samsung)" ]] || echo ' (tv/samsung modified)')"
} >> "${out}/build-info.txt"
cat "${out}/build-info.txt"
echo "Built ${wgt}"
