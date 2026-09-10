# Production embedding provider

## Active production contract

SkyOS production retrieval uses Vertex AI through Application Default Credentials (ADC). The active non-production qualification contract is:

- provider: `vertex`
- model: `gemini-embedding-001`
- SkyOS generation contract: `retrieval-v1`
- output dimensions: `768`
- embedding location: `europe-west1`
- document task: `RETRIEVAL_DOCUMENT`
- query task: `RETRIEVAL_QUERY`
- similarity: pgvector cosine distance (`<=>`), converted to similarity as `1 - distance`
- provider batch size: one input per request
- application character guard: 8,000 characters per input
- provider truncation: disabled (`autoTruncate=false`)
- aggregate provider deadline: 15 seconds
- automatic application retries: at most two retries after the initial request, only for retryable transport/408/409/429/5xx failures
- SDK retries: disabled for the individual provider request so SkyOS owns the retry budget

The model is requested at 768 dimensions through the provider-supported output-dimensionality parameter. SkyOS never pads or truncates returned vectors. Every returned vector must contain exactly 768 finite numeric values or the operation fails closed.

## Previous local contract

The development/test implementation is `DeterministicLocalEmbeddingProvider`:

- provider: `local`
- model: `deterministic-feature-hash`
- version: `1.0.0`
- dimensions: 64
- preprocessing: NFKC normalization, lower-case tokenization, word and character-trigram feature extraction
- projection: SHA-256 feature hashing with signed bucket accumulation
- normalization: L2 normalization
- maximum batch size: 32
- maximum input: 8,000 characters

This provider is not a semantic production model. It remains available only for isolated development and deterministic tests. Production construction rejects both an absent `EMBEDDING_PROVIDER` and `EMBEDDING_PROVIDER=local`; there is no runtime fallback from Vertex to local.

## Persistence and compatibility

The PostgreSQL `knowledge_embeddings.vector` column uses pgvector's general `vector` type rather than a fixed `vector(N)` declaration. Database constraints and triggers tie every vector to its `knowledge_embedding_set` and reject a vector whose `vector_dims()` differs from that set's declared dimension.

Each embedding job/set records `providerKey`, `modelKey`, `modelVersion`, and `dimensions`. The embedding input checksum also incorporates those four values plus the chunk text. Semantic search selects only successful embedding sets whose provider, model, model version, and dimension exactly match the currently configured query provider.

Therefore old 64-dimensional local sets and new 768-dimensional Vertex sets can coexist physically without being mixed in a similarity query. No destructive vector-column migration is required for this contract.

## Re-embedding and cutover strategy

Existing local vectors are incompatible with the Vertex semantic space and must not be treated as migrated merely because the database accepts both dimensions.

Use a controlled parallel rebuild before retrieval cutover:

1. Keep existing local embedding sets intact as rollback evidence; do not rewrite them in place.
2. Configure a qualification runtime with the Vertex contract and request a new embedding job for each active, current Knowledge chunk set.
3. The existing durable embedding job records the Vertex provider/model/version/dimension before execution. The worker resolves that exact version and fails if it is unavailable or dimensionally inconsistent.
4. Chunk embeddings are generated before the persistence transaction. A successful job creates a new embedding set and all vector rows atomically; a failed attempt does not create a partial set.
5. Retryable failures return the durable job to `QUEUED`; nonretryable failures become `FAILED`. A duplicate pending job for the same chunk set/provider/model/version is rejected.
6. Verify that every active current chunk set has a successful Vertex set matching the target contract before switching the retrieval runtime to Vertex.
7. After cutover, exact-contract filtering makes local sets invisible to semantic retrieval. Keep them until rollback risk has passed, then remove them only through a separately reviewed lifecycle operation.

Rollback before cutover is simply to stop the Vertex rebuild and retain the current retrieval contract. After a production cutover, do not introduce a silent local fallback; roll back the application/configuration as an explicit deployment decision if required.

## Data boundary

Embedding requests transmit only the text required to produce the embedding. For document ingestion this is the Knowledge chunk text. For semantic retrieval this is the normalized user query. Workspace IDs, organization IDs, document IDs, filenames, audit metadata, credentials, secret values, and database connection data are not included in the provider request.

Vertex authentication uses the runtime service account through ADC. No embedding API key belongs in source, browser bundles, Terraform values, or Secret Manager for this provider. The runtime IAM contract is the existing SkyOS custom Vertex prediction role containing only `aiplatform.endpoints.predict`.

## Runtime consumers

The web runtime currently performs synchronous background work and therefore needs the embedding configuration and Vertex prediction permission. The dedicated background worker also constructs the embedding registry and needs the same narrow prediction permission when it executes Knowledge embedding jobs.

The reconciliation job does not generate embeddings and does not need embedding configuration or Vertex prediction permission.

## Qualification gates

A release is not qualified by compilation, CI, a ready Cloud Run revision, or a direct model request alone. Task 5 requires all of the following against the deployed non-production contract:

- Terraform saved-plan review and convergence with no unexpected replacement or destroy
- runtime service-account identity and Vertex IAM verification
- one harmless live provider request proving model availability, ADC, finite numeric output, and exact dimension 768
- a real SkyOS Knowledge path run: create harmless Knowledge content, chunk it, generate/persist Vertex document embeddings, create the Vertex query embedding, execute pgvector retrieval, and observe the expected semantic result
- semantic sanity: a paraphrased query such as `Where is the plane kept?` must rank the chunk `The aircraft is stored inside the northern hangar.` materially above an unrelated control
- a negative-path check proving incompatible model/version/dimension metadata or provider failure fails clearly without local fallback
- cleanup of qualification data when the lifecycle contract allows it
- final Git verification of the exact deployed commit

Do not mark the production embedding task complete until these runtime gates have been observed.
