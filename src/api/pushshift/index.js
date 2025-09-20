import { fetchJson, sleep } from "../../utils"

export const chunkSize = 100
const postURL = "https://arctic-shift.photon-reddit.com/api/posts/ids?ids="
const commentURL =
  "https://arctic-shift.photon-reddit.com/api/comments/search?fields=author,body,created_utc,id,link_id,parent_id,retrieved_on,score,subreddit"

// same error handler + token bucket as before
const errorHandler = (msg, origError, from) => {
  console.error(from + ": " + origError)
  const error = new Error(msg)
  if (origError.name == "TypeError")
    error.helpUrl = "/about#apioff"
  throw error
}

class TokenBucket {
  constructor(msRefillIntvl, size) {
    if (!(msRefillIntvl > 0)) throw RangeError("msRefillIntvl must be > 0")
    if (!(size > 0)) throw RangeError("size must be > 0")
    this._msRefillIntvl = msRefillIntvl
    this._maxSize = size
    this._tokens = size
  }
  async waitForToken() {
    let msNow
    if (this._tokens < this._maxSize) {
      msNow = Date.now()
      if (msNow >= this._msNextRefill) {
        const newTokens =
          Math.floor((msNow - this._msNextRefill) / this._msRefillIntvl) + 1
        this._tokens += newTokens
        if (this._tokens < this._maxSize)
          this._msNextRefill += newTokens * this._msRefillIntvl
        else this._tokens = this._maxSize
      }
    }
    if (this._tokens > 0) {
      if (this._tokens == this._maxSize)
        this._msNextRefill = (msNow || Date.now()) + this._msRefillIntvl
      this._tokens--
    } else {
      await sleep(this._msNextRefill - msNow)
      this._msNextRefill += this._msRefillIntvl
    }
  }
  setNextAvail(msNextAvail) {
    this._tokens = 0
    this._msNextRefill = Date.now() + msNextAvail
  }
}

const apiTokenBucket = new TokenBucket(515, 7)

const toBase36 = id => {
  if (!id) return id
  if (typeof id == "number") return id.toString(36)
  else return id[2] == "_" ? id.substring(3) : id
}

export const getPost = async threadID => {
  await apiTokenBucket.waitForToken()
  try {
    // api expects base36 id directly (7jzpir)
    return (await fetchJson(`${postURL}${threadID}`)).data[0]
  } catch (error) {
    errorHandler("Could not get post", error, "api.getPost")
  }
}

export const getCommentsFromIds = async commentIDs => {
  if (commentIDs.length == 0) return []
  let response, delay = 0
  while (true) {
    await apiTokenBucket.waitForToken()
    try {
      const ids = commentIDs.join(",")
      response = await fetchJson(`${commentURL}&ids=${ids}`)
      break
    } catch (error) {
      if (delay >= 2000)
        errorHandler(
          "Could not get comments by IDs",
          error,
          "api.getCommentsFromIds"
        )
      delay = delay * 2 || 125
      apiTokenBucket.setNextAvail(delay)
      console.log("api.getCommentsFromIds delay: " + delay)
    }
  }
  return response.data.map(c => {
    c.link_id = toBase36(c.link_id)
    c.parent_id = toBase36(c.parent_id) || c.link_id
    return c
  })
}

export const getComments = async (
  callback,
  threadID,
  maxComments,
  after = -1,
  before = undefined
) => {
  let chunks = Math.floor(maxComments / chunkSize),
    response,
    lastCreatedUtc = 1
  while (true) {
    let query =
      `${commentURL}&limit=${chunkSize}&sort=asc&link_id=${threadID}` +
      (after > 0 ? `&after=${after}` : "") +
      (before ? `&before=${before}` : "")
    let delay = 0
    while (true) {
      await apiTokenBucket.waitForToken()
      try {
        response = await fetchJson(query)
        break
      } catch (error) {
        if (delay >= 8000)
          errorHandler("Could not get comments", error, "api.getComments")
        delay = delay * 2 || 125
        apiTokenBucket.setNextAvail(delay)
        if (!callback([])) return [lastCreatedUtc, false]
        console.log("api.getComments delay: " + delay)
      }
    }
    const comments = response.data || []
    const exitEarly = !callback(
      comments.map(c => ({
        ...c,
        parent_id: c.parent_id ? toBase36(c.parent_id) : threadID,
        link_id: c.link_id?.substring(3) || threadID
      }))
    )
    const loadedAllComments = comments.length < chunkSize * 0.75
    if (comments.length)
      lastCreatedUtc = comments[comments.length - 1].created_utc
    if (loadedAllComments || chunks <= 1 || exitEarly)
      return [lastCreatedUtc, loadedAllComments]
    chunks--
    after = Math.max(lastCreatedUtc - 1, after)
  }
}
