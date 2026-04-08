#!/usr/bin/env bash
# =============================================================================
# common.sh — Shared helpers for Hologram AI Agent scripts
# =============================================================================
#
# Source this file from setup/start scripts.
# Provides:
#   - Colored logging functions
#   - VS Agent API helpers (wait_for_agent)
#   - Network configuration (set_network_vars)
#   - ECS discovery helpers (discover_ecs_vtjsc)
#   - Credential helpers (issue_remote_and_link, has_linked_vp)
#   - CLI setup helpers (setup_veranad_account)
#   - Transaction helpers (extract_tx_json, extract_tx_event, check_balance)
#
# =============================================================================

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { echo -e "\n\033[1;34m▶ $1\033[0m" >&2; }
ok()   { echo -e "  \033[1;32m✔ $1\033[0m" >&2; }
err()  { echo -e "  \033[1;31m✘ $1\033[0m" >&2; }
warn() { echo -e "  \033[1;33m⚠ $1\033[0m" >&2; }

# ---------------------------------------------------------------------------
# Network configuration
# ---------------------------------------------------------------------------

set_network_vars() {
  local network="${1:-testnet}"

  case "$network" in
    devnet)
      CHAIN_ID="${CHAIN_ID:-vna-devnet-1}"
      NODE_RPC="${NODE_RPC:-https://rpc.devnet.verana.network}"
      FEES="${FEES:-600000uvna}"
      FAUCET_URL="https://faucet-vs.devnet.verana.network/invitation"
      RESOLVER_URL="${RESOLVER_URL:-https://resolver.devnet.verana.network}"
      ECS_TR_ADMIN_API="${ECS_TR_ADMIN_API:-https://admin-ecs-trust-registry.devnet.verana.network}"
      ECS_TR_PUBLIC_URL="${ECS_TR_PUBLIC_URL:-https://ecs-trust-registry.devnet.verana.network}"
      INDEXER_URL="${INDEXER_URL:-https://idx.devnet.verana.network}"
      ;;
    testnet)
      CHAIN_ID="${CHAIN_ID:-vna-testnet-1}"
      NODE_RPC="${NODE_RPC:-https://rpc.testnet.verana.network}"
      FEES="${FEES:-600000uvna}"
      FAUCET_URL="https://faucet-vs.testnet.verana.network/invitation"
      RESOLVER_URL="${RESOLVER_URL:-https://resolver.testnet.verana.network}"
      ECS_TR_ADMIN_API="${ECS_TR_ADMIN_API:-https://admin-ecs-trust-registry.testnet.verana.network}"
      ECS_TR_PUBLIC_URL="${ECS_TR_PUBLIC_URL:-https://ecs-trust-registry.testnet.verana.network}"
      INDEXER_URL="${INDEXER_URL:-https://idx.testnet.verana.network}"
      ;;
    *)
      err "Unknown network: $network. Use 'devnet' or 'testnet'."
      exit 1
      ;;
  esac

  export CHAIN_ID NODE_RPC FEES FAUCET_URL RESOLVER_URL ECS_TR_ADMIN_API ECS_TR_PUBLIC_URL INDEXER_URL
}

# ---------------------------------------------------------------------------
# Transaction helpers
# ---------------------------------------------------------------------------

extract_tx_event() {
  local tx_hash=$1
  local event_type=$2
  local attr_key=$3
  veranad q tx "$tx_hash" --node "$NODE_RPC" --output json 2>/dev/null \
    | jq -r ".events[] | select(.type == \"$event_type\") | .attributes[] | select(.key == \"$attr_key\") | .value" \
    | head -1
}

extract_tx_json() {
  grep -E '^\{' | head -1
}

check_balance() {
  local user_acc=$1
  local addr
  addr=$(veranad keys show "$user_acc" -a --keyring-backend test 2>/dev/null)
  if [ -z "$addr" ]; then
    err "Account '$user_acc' not found in keyring"
    return 1
  fi

  local balance
  balance=$(veranad q bank balances "$addr" --node "$NODE_RPC" --output json 2>/dev/null \
    | jq -r '.balances[]? | select(.denom == "uvna") | .amount // "0"' 2>/dev/null || echo "0")

  if [ -z "$balance" ] || [ "$balance" = "0" ]; then
    err "Account '$user_acc' ($addr) has no uvna balance."
    err "Top up using the faucet: ${FAUCET_URL}"
    return 1
  fi

  ok "Account balance: ${balance} uvna"
}

# ---------------------------------------------------------------------------
# VS Agent API helpers
# ---------------------------------------------------------------------------

wait_for_agent() {
  local admin_api=$1
  local max_retries=${2:-30}
  local i=0
  while [ $i -lt "$max_retries" ]; do
    if curl -sf "${admin_api}/v1/agent" > /dev/null 2>&1; then
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# ECS Trust Registry discovery helpers
# ---------------------------------------------------------------------------

discover_ecs_vtjsc() {
  local ecs_public_url=$1
  local schema_name=$2

  log "Resolving ECS TR DID document for '$schema_name' VTJSC..."

  local did_doc
  did_doc=$(curl -sf "${ecs_public_url}/.well-known/did.json")
  if [ -z "$did_doc" ]; then
    err "Failed to fetch DID document from ${ecs_public_url}/.well-known/did.json"
    return 1
  fi

  local vp_url
  vp_url=$(echo "$did_doc" | jq -r --arg pat "${schema_name}-jsc-vp" '
    .service[] | select(.type == "LinkedVerifiablePresentation") |
    select(.id | test($pat)) | .serviceEndpoint' | head -1)

  if [ -z "$vp_url" ]; then
    err "No LinkedVerifiablePresentation matching '${schema_name}-jsc-vp' in DID document"
    return 1
  fi
  ok "VTJSC VP endpoint: $vp_url"

  local vp
  vp=$(curl -sf "$vp_url")
  if [ -z "$vp" ]; then
    err "Failed to fetch VTJSC VP from $vp_url"
    return 1
  fi

  local vtjsc_url
  vtjsc_url=$(echo "$vp" | jq -r '.verifiableCredential[0].id // empty')
  if [ -z "$vtjsc_url" ]; then
    err "Could not extract VTJSC URL from VP"
    return 1
  fi

  local schema_ref
  schema_ref=$(echo "$vp" | jq -r '.verifiableCredential[0].credentialSubject.jsonSchema."$ref" // empty')
  if [ -z "$schema_ref" ]; then
    err "Could not extract jsonSchema.\$ref from VTJSC"
    return 1
  fi

  local schema_id
  schema_id=$(echo "$schema_ref" | grep -oE '[0-9]+$')
  if [ -z "$schema_id" ]; then
    err "Could not parse schema ID from ref: $schema_ref"
    return 1
  fi

  ok "VTJSC '$schema_name' → URL: $vtjsc_url, schema ID: $schema_id"
  echo "$vtjsc_url"
  echo "$schema_id"
}

# ---------------------------------------------------------------------------
# Credential helpers
# ---------------------------------------------------------------------------

issue_remote_and_link() {
  local remote_api=$1
  local local_api=$2
  local schema_base_id=$3
  local jsc_url=$4
  local target_did=$5
  local claims_json=$6

  local request_body
  request_body=$(jq -n \
    --arg fmt "jsonld" \
    --arg did "$target_did" \
    --arg jsc "$jsc_url" \
    --argjson claims "$claims_json" \
    '{format: $fmt, did: $did, jsonSchemaCredentialId: $jsc, claims: $claims}')

  local issue_url="${remote_api}/v1/vt/issue-credential"
  log "Requesting credential from remote API: $issue_url"

  local http_code credential
  http_code=$(curl -s -o /tmp/issue_response.json -w '%{http_code}' \
    -X POST "$issue_url" \
    -H 'Content-Type: application/json' \
    -d "$request_body")
  credential=$(cat /tmp/issue_response.json)

  if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
    err "Remote API returned HTTP $http_code"
    err "Response: $credential"
    return 1
  fi

  if [ -z "$credential" ] || echo "$credential" | jq -e '.statusCode' > /dev/null 2>&1; then
    err "Remote API failed to issue credential. Response: $credential"
    return 1
  fi
  ok "Credential received from remote API (HTTP $http_code)"

  local signed_cred
  signed_cred=$(echo "$credential" | jq '.credential')
  if [ "$signed_cred" = "null" ] || [ -z "$signed_cred" ]; then
    signed_cred="$credential"
  fi

  local link_url="${local_api}/v1/vt/linked-credentials"
  curl -s -X DELETE "${link_url}" \
    -H 'Content-Type: application/json' \
    -d "{\"credentialSchemaId\": \"$jsc_url\"}" > /dev/null 2>&1 || true
  log "Linking credential on local agent: $link_url"

  local link_body
  link_body=$(jq -n \
    --arg sbi "$schema_base_id" \
    --argjson cred "$signed_cred" \
    '{schemaBaseId: $sbi, credential: $cred}')

  local link_code link_result
  link_code=$(curl -s -o /tmp/link_response.json -w '%{http_code}' \
    -X POST "$link_url" \
    -H 'Content-Type: application/json' \
    -d "$link_body")
  link_result=$(cat /tmp/link_response.json)

  if [ "$link_code" != "200" ] && [ "$link_code" != "201" ]; then
    err "Failed to link credential (HTTP $link_code). Response: $link_result"
    return 1
  fi
  ok "Credential linked as VP on local agent (schemaBaseId: $schema_base_id)"
}

has_linked_vp() {
  local public_url=$1
  local schema_base_id=$2

  local did_doc
  did_doc=$(curl -sf "${public_url}/.well-known/did.json" 2>/dev/null) || return 1

  local match
  match=$(echo "$did_doc" | jq -r \
    --arg sbi "$schema_base_id" \
    '.service[] |
     select(.type == "LinkedVerifiablePresentation") |
     select(.id | test($sbi + "-jsc-vp")) |
     .id' 2>/dev/null | head -1)

  [ -n "$match" ]
}

# ---------------------------------------------------------------------------
# Logo helper
# ---------------------------------------------------------------------------

download_logo_data_uri() {
  local url=$1
  local tmp_body="/tmp/logo_body_$$"
  local tmp_headers="/tmp/logo_headers_$$"

  local http_code
  http_code=$(curl -sfL -D "$tmp_headers" -o "$tmp_body" -w '%{http_code}' "$url")

  if [ "$http_code" != "200" ] || [ ! -s "$tmp_body" ]; then
    err "Failed to download logo from $url (HTTP $http_code)"
    rm -f "$tmp_body" "$tmp_headers"
    return 1
  fi

  local content_type
  content_type=$(grep -i '^content-type:' "$tmp_headers" | tail -1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//' | cut -d';' -f1 | xargs)

  case "$content_type" in
    image/png|image/jpeg|image/svg+xml) ;;
    *)
      case "$url" in
        *.png)          content_type="image/png" ;;
        *.jpg|*.jpeg)   content_type="image/jpeg" ;;
        *.svg)          content_type="image/svg+xml" ;;
        *)
          err "Could not determine image content type for $url (got: ${content_type:-empty})"
          rm -f "$tmp_body" "$tmp_headers"
          return 1
          ;;
      esac
      ;;
  esac

  local b64
  b64=$(base64 < "$tmp_body" | tr -d '\n')
  rm -f "$tmp_body" "$tmp_headers"

  if [ -z "$b64" ]; then
    err "Failed to base64-encode logo from $url"
    return 1
  fi

  echo "data:${content_type};base64,${b64}"
}

# ---------------------------------------------------------------------------
# CLI setup helpers
# ---------------------------------------------------------------------------

setup_veranad_account() {
  local user_acc=$1
  local faucet_url=$2

  if ! veranad keys show "$user_acc" --keyring-backend test > /dev/null 2>&1; then
    log "Creating new account '$user_acc'..."
    veranad keys add "$user_acc" --keyring-backend test 2>&1
    ok "Account created"
  else
    ok "Account '$user_acc' already exists"
  fi

  USER_ACC_ADDR=$(veranad keys show "$user_acc" -a --keyring-backend test)
  ok "Account address: $USER_ACC_ADDR"

  local balance
  balance=$(veranad q bank balances "$USER_ACC_ADDR" --node "$NODE_RPC" --output json 2>/dev/null \
    | jq -r '.balances[] | select(.denom == "uvna") | .amount // "0"' 2>/dev/null || echo "0")

  if [ "$balance" = "0" ] || [ -z "$balance" ]; then
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────────┐"
    echo "  │  Fund this account via the faucet:                          │"
    echo "  │                                                             │"
    echo "  │  Address: $USER_ACC_ADDR"
    echo "  │                                                             │"
    echo "  │  Faucet:  $faucet_url"
    echo "  └─────────────────────────────────────────────────────────────┘"
    echo ""
    read -rp "  Press Enter once the account is funded (or Ctrl+C to abort)... "

    balance=$(veranad q bank balances "$USER_ACC_ADDR" --node "$NODE_RPC" --output json 2>/dev/null \
      | jq -r '.balances[] | select(.denom == "uvna") | .amount // "0"' 2>/dev/null || echo "0")
    if [ "$balance" = "0" ] || [ -z "$balance" ]; then
      err "Account still has no uvna balance. Please fund it before continuing."
      exit 1
    fi
  fi

  ok "Account balance: ${balance} uvna"
  export USER_ACC_ADDR
}
