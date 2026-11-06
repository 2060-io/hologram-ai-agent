# X Agent: deploy your own

The X Agent drafts short posts for one X (Twitter) account, with a matching image, and publishes them once you approve. You talk to it in an encrypted DIDComm chat in [Hologram Messaging](https://hologram.zone).

There is no shared demo: each X Agent is tied to one X account, so you deploy your own. This folder is the example: the agent pack, and the values of the two charts it runs on.

| File | What it is |
|---|---|
| [`agent-pack.yaml`](agent-pack.yaml) | The agent pack for hologram-ai-agent v2 (fields: [`docs/agent-pack-schema.md`](../../docs/agent-pack-schema.md)): prompts in English, Spanish and French, RAG sources, login, X tools, speech-to-text, vision and image generation. |
| [`x-agent.yaml`](x-agent.yaml) | Values of `io2060/hologram-ai-agent-chart` v2.0.0: the agent with Redis and Postgres, and its VS Agent on Verana testnet. |
| [`x-mcp.yaml`](x-mcp.yaml) | Values of `io2060/x-autonomous-mcp-chart` v0.1.13: [x-autonomous-mcp](https://github.com/2060-io/x-autonomous-mcp), the MCP server that holds the X API credentials. |

```
Hologram app <-> VS Agent (DIDComm) <-> hologram-ai-agent (LLM) <-> x-autonomous-mcp <-> X API v2
```

The example pack is the 2060 publishing agent: its prompts and RAG sources are about Verana. Change `languages`, `llm.agentPrompt` and `rag.remoteUrls` for your own subject.

## Who can publish

Users log in with an **Avatar Credential** (the Hologram demo ecosystem of 2060 OÜ, schema `https://corp.2060.io/vt/schemas-57-jsc.json` on testnet). Users without one get an invitation to the [Avatar demo](https://hologram.zone/demos).

Only the Avatar names in `ADMIN_USERS` can use the X tools (`toolAccess.default: admin`). To grant publishing to a team, list their Avatar names, or bind the X tools to another credential in the pack.

## Before you start

- **A Kubernetes cluster** with an ingress controller and cert-manager. The values use the class `nginx` and the issuer `letsencrypt-prod`, as the vs-agent chart does.
- **X API credentials** from the [X Developer Portal](https://developer.x.com/en/portal/dashboard). The Free tier is enough to publish.
  - OAuth 1.0a, with the app permissions set to "Read and write": API Key, API Secret, Access Token, Access Token Secret.
  - The OAuth 2.0 Bearer Token.
- **An OpenAI API key**: chat, speech-to-text, vision and image generation.
- **A Verana corporation** on testnet, with a VS Agent of your organization that holds its ECS credential.
  - The X Agent is a delegated service of that agent, which issues its ECS-Service credential.
  - See the [Verana docs](https://docs.verana.io).
- **Optional, for images:** an S3-compatible object store with a public URL. MinIO no longer publishes public images; [SeaweedFS](https://github.com/seaweedfs/seaweedfs) works. Without it, the agent publishes text posts only.

## Deploy

1. **The X MCP server:**
   ```bash
   helm upgrade --install x-mcp oci://registry-1.docker.io/io2060/x-autonomous-mcp-chart \
     --version v0.1.13 -n <namespace> -f x-mcp.yaml \
     --set secret.X_API_KEY=... --set secret.X_API_SECRET=... \
     --set secret.X_ACCESS_TOKEN=... --set secret.X_ACCESS_TOKEN_SECRET=... \
     --set secret.X_BEARER_TOKEN=...
   ```
2. **The Verana account of the service:** create the Secret `x-agent-verana-account` (key `mnemonic`) with the mnemonic of a new account, funded with a little VNA.
3. **Edit `x-agent.yaml`:** replace each `<...>`, at least these:
   - `global.domain`. The agent is reachable at `x-agent.<domain>`, and that host becomes part of its DID.
   - `ADMIN_USERS`
   - `veranaCorporationId`
   - `delegatedParentVsDid`
4. **The agent:**
   ```bash
   helm upgrade --install x-agent oci://registry-1.docker.io/io2060/hologram-ai-agent-chart \
     --version v2.0.0 -n <namespace> -f x-agent.yaml \
     --set-file chatbot.agentPack.content=agent-pack.yaml \
     --set chatbot.secret.OPENAI_API_KEY=... \
     --set chatbot.secret.POSTGRES_PASSWORD=<pw> --set postgres.secret.POSTGRES_PASSWORD=<pw>
   ```
5. **Onboard the service on Verana:**
   - Your organization's VS Agent issues its ECS-Service credential.
   - The service needs a VERIFIER participant on the Avatar Credential schema (open onboarding), so it can ask for the Avatar Credential.

   See the [Verana docs](https://docs.verana.io) for onboarding a Verifiable Service and its participants.
6. **Connect:** the VS Agent accepts a static out-of-band invitation to its DID.
   - **Find the DID:** it is the `state.id` of the last line of `https://x-agent.<domain>/.well-known/did.jsonl`.
   - **Build the invitation** from this JSON:
     ```json
     {
       "@type": "https://didcomm.org/out-of-band/1.1/invitation",
       "@id": "<DID>",
       "label": "X Agent",
       "handshake_protocols": ["https://didcomm.org/didexchange/1.1"],
       "services": ["<DID>"]
     }
     ```
   - **Open the link** `https://hologram.zone/invitation?oob=<base64url of the JSON>`. It shows a QR on desktop and opens Hologram Messaging on a phone.

   Then log in with your Avatar Credential and ask for a post.

## Safety rails

x-autonomous-mcp caps the actions per day (`x-mcp.yaml`, `env`): 10 posts, 8 replies, 20 likes, 5 retweets, 10 follows, 10 unfollows, 5 deletes. It also never engages twice with the same post. The agent asks for your approval before it publishes anything.
