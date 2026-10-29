/**
 * Retrieval scoring for dsh-memory-forge.
 *
 * Everything here is pure: tokenization, the BM25 statistics over a snapshot of
 * entries, and the relevance blend. No filesystem, clock, or logger access, which
 * keeps the ranking behavior unit-testable and deterministic.
 *
 * Ranking combines three signals that matter for agent memory:
 *   - lexical relevance (BM25 over text and tags),
 *   - query coverage (how much of the query's information mass matched),
 *   - recency (a half-life decay, so stale notes lose to fresh ones).
 */

const CJK_RANGES = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af'
const TOKEN_PATTERN = new RegExp(`[a-z0-9_]+|[${CJK_RANGES}]+`, 'gu')
const CJK_PATTERN = new RegExp(`[${CJK_RANGES}]`, 'u')

const BM25_K1 = 1.2
const BM25_B = 0.75
/** Information mass of a term that appears in every document; keeps idf usable. */
const IDF_FLOOR = 0.05
/** Raw BM25 score at which saturation is half its ceiling. */
const SATURATION_SCALE = 3
const COVERAGE_WEIGHT = 0.65
const RECENCY_FLOOR = 0.75

/**
 * Function words that carry no retrieval signal.
 *
 * They matter more than they look: a small corpus gives an unmatched "how" or
 * "的" a high inverse document frequency, so leaving them in the query would
 * depress coverage for a document that matches every content term. Filtering
 * them here keeps `recallMinScore` meaningful across corpora of any size.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'before', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no', 'not', 'now', 'of', 'on',
  'once', 'only', 'or', 'other', 'our', 'out', 'over', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '就', '也', '和', '与', '吗', '呢', '吧', '啊',
  '要', '会', '把', '被', '对', '上', '下', '中', '个', '不', '有', '很', '再', '都', '只', '而', '及', '或', '但', '里',
  '着', '过', '之', '其', '呢', '吧', '哦', '嗯',
])

/**
 * Split text into lexical terms.
 *
 * Latin runs are lowercased words with a light plural stemming. CJK runs emit
 * unigrams and bigrams, which gives usable recall without a segmentation model:
 * bigrams carry most of the signal and single characters keep short queries alive.
 * Function words are dropped because they inflate coverage denominators without
 * distinguishing documents.
 *
 * @param {string} text - arbitrary text.
 * @returns {string[]} terms in occurrence order, duplicates preserved.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const normalized = text.normalize('NFKC').toLowerCase()
  const terms = []
  const push = (term) => {
    if (!STOPWORDS.has(term)) terms.push(term)
  }
  for (const match of normalized.matchAll(TOKEN_PATTERN)) {
    const chunk = match[0]
    if (CJK_PATTERN.test(chunk)) {
      const characters = [...chunk]
      for (const character of characters) push(character)
      for (let index = 0; index + 1 < characters.length; index += 1) terms.push(characters[index] + characters[index + 1])
      continue
    }
    push(chunk)
    if (chunk.length > 4 && chunk.endsWith('s')) push(chunk.slice(0, -1))
  }
  return terms
}

/**
 * Build term frequencies for one document.
 * @param {string[]} terms - tokenized terms.
 * @returns {Map<string, number>} term to count.
 */
function frequencies(terms) {
  const counts = new Map()
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
}

/**
 * Derive the searchable text of one entry: its text plus tags plus kind.
 * @param {{text?: string, tags?: string[], kind?: string}} entry - stored memory.
 * @returns {string} the concatenated searchable text.
 */
export function entryText(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags : []
  return [entry.text ?? '', tags.join(' '), entry.kind ?? ''].join(' ')
}

/**
 * Precompute scoring statistics for a set of entries.
 * @param {Array<Record<string, any>>} entries - candidate memories.
 * @returns {{documents: Array<{entry: Record<string, any>, counts: Map<string, number>, length: number}>, documentFrequency: Map<string, number>, averageLength: number, total: number}}
 */
export function prepareIndex(entries) {
  const list = Array.isArray(entries) ? entries : []
  const documents = []
  const documentFrequency = new Map()
  let totalLength = 0

  for (const entry of list) {
    const terms = tokenize(entryText(entry))
    const counts = frequencies(terms)
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    totalLength += terms.length
    documents.push({ entry, counts, length: terms.length })
  }

  return {
    documents,
    documentFrequency,
    averageLength: documents.length === 0 ? 0 : totalLength / documents.length,
    total: documents.length,
  }
}

/**
 * Inverse document frequency of one term, floored so ubiquitous terms stay useful.
 * @param {Map<string, number>} documentFrequency - term to document count.
 * @param {number} total - number of documents.
 * @param {string} term - query term.
 * @returns {number} a positive idf weight.
 */
export function inverseDocumentFrequency(documentFrequency, total, term) {
  const frequency = documentFrequency.get(term) ?? 0
  const ratio = (total - frequency + 0.5) / (frequency + 0.5)
  return Math.max(IDF_FLOOR, Math.log(1 + ratio))
}

/**
 * Recency multiplier from an entry's age.
 * @param {number} createdAt - epoch milliseconds.
 * @param {number} now - epoch milliseconds.
 * @param {number} halfLifeDays - decay half-life; zero or negative disables decay.
 * @returns {number} a multiplier in [RECENCY_FLOOR, 1].
 */
export function recencyWeight(createdAt, now, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1
  if (!Number.isFinite(createdAt) || createdAt <= 0) return RECENCY_FLOOR
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000)
  const decay = 0.5 ** (ageDays / halfLifeDays)
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decay
}

/**
 * Score every entry against a query.
 *
 * `score` is a 0..1 blend of coverage and saturated BM25, discounted by recency.
 * Coverage is reported separately so callers can threshold on "did the query
 * actually match" rather than on length-biased BM25 alone.
 *
 * @param {Array<Record<string, any>>} entries - candidate memories.
 * @param {string} query - the user's text.
 * @param {{now?: number, halfLifeDays?: number, minScore?: number, limit?: number}} [options] - scoring controls.
 * @returns {Array<{entry: Record<string, any>, score: number, coverage: number, bm25: number, matched: string[]}>} ranked matches.
 */
export function rankEntries(entries, query, options = {}) {
  const now = options.now ?? Date.now()
  const halfLifeDays = options.halfLifeDays ?? 30
  const minScore = options.minScore ?? 0
  const limit = options.limit ?? Number.POSITIVE_INFINITY

  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []

  const index = prepareIndex(entries)
  const queryWeights = new Map()
  let totalQueryWeight = 0
  for (const term of queryTerms) {
    const weight = inverseDocumentFrequency(index.documentFrequency, index.total, term)
    queryWeights.set(term, weight)
    totalQueryWeight += weight
  }

  const scored = []
  for (const document of index.documents) {
    let bm25 = 0
    let matchedWeight = 0
    const matched = []
    for (const [term, weight] of queryWeights) {
      const frequency = document.counts.get(term)
      if (frequency === undefined) continue
      matched.push(term)
      matchedWeight += weight
      const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * document.length) / Math.max(1, index.averageLength))
      bm25 += weight * ((frequency * (BM25_K1 + 1)) / denominator)
    }
    if (matched.length === 0) continue

    const coverage = totalQueryWeight === 0 ? 0 : matchedWeight / totalQueryWeight
    const saturation = bm25 / (bm25 + SATURATION_SCALE)
    const relevance = COVERAGE_WEIGHT * coverage + (1 - COVERAGE_WEIGHT) * saturation
    const score = relevance * recencyWeight(document.entry.createdAt, now, halfLifeDays)
    if (score < minScore) continue
    scored.push({ entry: document.entry, score, coverage, bm25, matched })
  }

  scored.sort((left, right) => right.score - left.score || (right.entry.createdAt ?? 0) - (left.entry.createdAt ?? 0))
  return Number.isFinite(limit) ? scored.slice(0, Math.max(0, limit)) : scored
}
