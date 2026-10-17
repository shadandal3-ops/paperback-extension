import {
    BadgeColor,
    Chapter,
    ChapterDetails,
    ChapterProviding,
    CloudflareBypassRequestProviding,
    ContentRating,
    HomePageSectionsProviding,
    HomeSection,
    HomeSectionType,
    MangaProviding,
    PagedResults,
    PartialSourceManga,
    Request,
    Response,
    SearchRequest,
    SearchResultsProviding,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Tag,
    TagSection
} from '@paperback/types'

import * as cheerio from 'cheerio'
import { GROUP_REFUSAL_MESSAGE, groupRefusal, TAG_ONLY_LABELS } from '../NHentai/ContentRules'

export const HH_DOMAIN = 'https://hentaihere.com'

/**
 * Excluded by standing request, by tag name. Checked against every tag a
 * series or card names, and used to scrub the catalog offered in the filter UI.
 */
const BANNED_LABELS = /yaoi|boys?.?love|shounen[ -]?ai|\bmales only\b|tomgirl|crossdress|ugly bastard|\bbald\b|\bfat\b|gigantic breasts|\bold\s*m[ae]n\b|\bolder\s*m[ae]n\b|\bold\s*guy\b|\bgrandfather\b|\bgrandpa\b|\bgrand-?dad\b|\bgramps\b|\bdilf\b|reverse[- ]?harem|\bbbm\b|\bgang|\borgy\b|\b[mt]{2,}[mtf]\s*(?:threesome|foursome)\b|\bmm+f?\b|bestial|\bfurry\b|animal on|human on furry|octopus|\btentacl|\bmonster|\bslime\b|\binsect|\bsnake\b|\bspider\b|\bworm\b|\bcentaur\b|\bminotaur\b|\bhorse\b|\bdog\b|\bcat\b(?!\s*ears)|\bpig\b|\bfish\b|\bfrog\b|\bbird (?:girl|boy)\b|\bbear\b|\bwolf\b|\balien\b/i

/**
 * "Trap", the site's name for tomgirl, and its kin -- tags only, since "trap"
 * in a title is as likely "Honey Trap".
 */
const SITE_BANNED_LABELS = /\btrap\b|\bfemboy\b|\botokonoko\b/i

/**
 * The same exclusions as the site's own tag ids, sent as `without=` on every
 * listing so the server leaves them out and pages come back full. Resolved by
 * name from the site's tag index (/search/tags, Oct 2026); any tag added later
 * is caught by name on the card and at the details gate, and joins this list
 * once the index has been read (see bannedIds).
 */
const BANNED_TAG_IDS = [
    '24', // Tentacles
    '27', // Yaoi
    '343', // Crossdressing
    '344', // Trap
    '353', // Dog Girls
    '429', // Gang Rape
    '462', // Gangbang
    '567', // Reverse Harem
    '696', // Ganguro
    '957', // Cat Girls
    '1175', // Monsters
    '1243', // Monster Sex
    '1268', // Fox Girls
    '1371', // Cow Girls
    '1409', // Monster Girls
    '1412', // Wolf Girls
    '1688', // Threesome (MMF)
    '2315', // Furry
    '2331', // Old Man
    '2753', // Lizard Girl
    '2763' // Insect
]

const bannedName = (name: string): boolean =>
    BANNED_LABELS.test(name) || TAG_ONLY_LABELS.test(name) || SITE_BANNED_LABELS.test(name)

/**
 * Parodies are excluded, and on this site a parody is exactly what it files as
 * "Doujinshi": every doujinshi names the series it parodies, and no original
 * names one. So listings ask for originals only (`type=original`), and the
 * details gate refuses anything with a parody or a doujinshi or video type.
 */
const LISTING_TYPE = 'original'
const REFUSED_TYPES = /^(?:doujinshi|videos?)$/i

const SECTIONS: { id: string; label: string; sort: string }[] = [
    { id: 'last-updated', label: 'Last Updated (Filtered)', sort: 'latest' },
    { id: 'newest', label: 'Newest (Filtered)', sort: 'newest' },
    { id: 'most-popular', label: 'Most Popular (Filtered)', sort: 'most-viewed' }
]

interface ListingMetadata {
    page?: number
    seen?: string[]
}

interface Book {
    id: string
    title: string
    cover: string
    type: string
    status: string
    artists: string[]
    parodies: string[]
    tags: { id: string; name: string }[]
    chapters: { id: string; number: number; name: string; time?: Date }[]
    refusal?: string
}

const MONTH_MS = 30 * 86400000
const UNIT_MS: Record<string, number> = {
    second: 1000, minute: 60000, hour: 3600000, day: 86400000,
    week: 7 * 86400000, month: MONTH_MS, year: 365 * 86400000
}

/** "3 days ago", "an hour ago" -- the only dates the site shows a chapter with. */
const relativeDate = (text: string): Date | undefined => {
    const match = /(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text)
    if (match == undefined) return /just now|today/i.test(text) ? new Date() : undefined
    const count = /^an?$/i.test(match[1] as string) ? 1 : Number(match[1])
    return new Date(Date.now() - count * (UNIT_MS[(match[2] as string).toLowerCase()] ?? 0))
}

/** The numeric book id from a manga id: `S56854` (the old form) or `56854`. */
const bookId = (mangaId: string): string => mangaId.replace(/^S/, '')

/**
 * hentaihere.com, filtered.
 *
 * The site was rebuilt in October 2026: series live at /{type}/{id}-{slug},
 * the reader at /reader/{id}-{slug}/{chapter}/page-1, and both answer the
 * short /{type}/{id} and /reader/{id}/{chapter} forms with a redirect. The old
 * /m/S{id} addresses redirect as well, so manga ids keep their `S{id}` form and
 * library entries saved before the rebuild still open.
 *
 * Listings come from /search, which takes tags to include (`with`) and leave
 * out (`without`) and so does the standing exclusions server-side. Each card
 * names its tags too, so the rules are checked again before a card is shown,
 * and the details gate backstops both.
 */
export const HentaiHereInfo: SourceInfo = {
    version: '2.0.0',
    name: 'HentaiHere (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentaihere.com with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: HH_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class HentaiHere implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 30000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${HH_DOMAIN}/`,
                        'user-agent': await this.requestManager.getDefaultUserAgent()
                    }
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    })

    getMangaShareUrl(mangaId: string): string {
        return `${HH_DOMAIN}/original/${bookId(mangaId)}`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${HH_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${HH_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private cloudflareError(): Error {
        return new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${HentaiHereInfo.name}> and press the cloud icon.`)
    }

    private checkResponse(status: number): void {
        if (status === 403 || status === 503) throw this.cloudflareError()
        if (status === 404) throw new Error('This title is no longer on the site.')
        if (status === 429) throw new Error('The site is rate limiting this connection (HTTP 429). Wait a moment and try again.')
        if (status >= 500) {
            throw new Error(`The site returned an error (HTTP ${status}). It is probably down or overloaded -- try again shortly.`)
        }
        if (status < 200 || status >= 300) {
            throw new Error(`Unexpected response from the site (HTTP ${status}).`)
        }
    }

    private async fetchText(url: string): Promise<string> {
        const response = await this.requestManager.schedule(App.createRequest({ url: url, method: 'GET' }), 2)
        this.checkResponse(response.status)
        const text = response.data as string
        // The challenge page can arrive with a success status.
        if (/<title>\s*Just a moment/i.test(text)) throw this.cloudflareError()
        return text
    }

    /** The tag index, `{id, name, count}` per tag, read once per session. */
    private catalog: { id: number; name: string }[] | undefined

    private async loadCatalog(): Promise<{ id: number; name: string }[]> {
        if (this.catalog != undefined) return this.catalog
        const parsed = JSON.parse(await this.fetchText(`${HH_DOMAIN}/search/tags`)) as { id: number; name: string }[]
        this.catalog = Array.isArray(parsed) ? parsed : []
        return this.catalog
    }

    /** The server-side exclusion: the resolved ids, plus any the index names since. */
    private async bannedIds(): Promise<string[]> {
        const ids = [...BANNED_TAG_IDS]
        try {
            for (const tag of await this.loadCatalog()) {
                if (bannedName(tag.name) && !ids.includes(String(tag.id))) ids.push(String(tag.id))
            }
        } catch {
            // The resolved list stands on its own.
        }
        return ids
    }

    private async searchUrl(options: { q?: string; sort?: string; include?: string[]; exclude?: string[] }, page: number): Promise<string> {
        const without = await this.bannedIds()
        for (const id of options.exclude ?? []) {
            if (!without.includes(id)) without.push(id)
        }

        const params = [`type=${LISTING_TYPE}`]
        if (options.q != undefined && options.q.length > 0) params.unshift(`q=${encodeURIComponent(options.q)}`)
        if ((options.include ?? []).length > 0) params.push(`with=${(options.include as string[]).join(',')}`)
        params.push(`without=${without.join(',')}`)
        if (options.sort != undefined) params.push(`sort=${options.sort}`)
        if (page > 1) params.push(`page=${page}`)
        return `${HH_DOMAIN}/search?${params.join('&')}`
    }

    /**
     * Listing cards: `article[data-card]`, each carrying its book id, its title,
     * its type ("A original by ...") and its tags as links.
     */
    private parseCards(html: string, seen: Set<string>): PartialSourceManga[] {
        const $ = cheerio.load(html)
        const tiles: PartialSourceManga[] = []

        for (const element of $('article[data-card][data-book]').toArray()) {
            const card = $(element)
            const id = `S${card.attr('data-book') ?? ''}`
            const title = card.find('h3').first().text().replace(/\s+/g, ' ').trim()
            if (id === 'S' || title.length === 0 || seen.has(id)) continue

            const type = /\/browse\/([a-z]+)/.exec(card.find('a[href*="/browse/"]').first().attr('href') ?? '')?.[1] ?? ''
            if (REFUSED_TYPES.test(type)) continue

            const labels = card.find('a[href*="/category/"], a[href*="/content/"]').toArray().map((anchor) => $(anchor).text().trim())
            if (labels.some(bannedName) || groupRefusal(labels) != undefined || BANNED_LABELS.test(title)) continue

            const image = card.find('img').first().attr('src') ?? `https://hermes.hentai.direct/hentai/cover/_${id}.jpg`

            seen.add(id)
            tiles.push(App.createPartialSourceManga({ mangaId: id, image: image, title: title }))
        }

        return tiles
    }

    private hasNextPage(html: string): boolean {
        return /<a[^>]*rel="next"/.test(html)
    }

    private async listing(url: string, page: number, seen: Set<string>): Promise<PagedResults> {
        const html = await this.fetchText(url)
        return App.createPagedResults({
            results: this.parseCards(html, seen),
            metadata: this.hasNextPage(html) ? { page: page + 1, seen: Array.from(seen) } : undefined
        })
    }

    /** A series page, read and judged by the standing rules. */
    private async book(mangaId: string): Promise<Book> {
        const $ = cheerio.load(await this.fetchText(this.getMangaShareUrl(mangaId)))

        const detail = (label: string) => $('dl div').toArray()
            .map((element) => $(element))
            .find((row) => row.find('dt').first().text().trim().toLowerCase() === label)
            ?.find('dd').first()
        const names = (label: string) => (detail(label)?.find('a').toArray() ?? [])
            .map((element) => $(element).text().replace(/\s+/g, ' ').trim())
            .filter((name) => name.length > 0)

        const tags: { id: string; name: string }[] = []
        for (const element of $('ul[aria-label="Tags"] a').toArray()) {
            const id = /\/(?:category|content)\/(\d+)/.exec($(element).attr('href') ?? '')?.[1]
            const name = $(element).text().replace(/\s+/g, ' ').trim()
            if (id != undefined && name.length > 0 && !tags.some((tag) => tag.id === id)) tags.push({ id: id, name: name })
        }

        // Every chapter is an option in the preview's chapter picker, newest
        // first: "Chapter 4 - Season 2 (latest)".
        const chapters: Book['chapters'] = []
        for (const element of $('select[name="pages"] option').toArray()) {
            const option = $(element)
            const id = option.attr('value') ?? ''
            if (!/^\d+$/.test(id) || chapters.some((chapter) => chapter.id === id)) continue

            const label = option.text().replace(/\s+/g, ' ').replace(/\s*\(latest\)\s*$/i, '').trim()
            const number = Number(/^chapter\s+(\d+(?:\.\d+)?)/i.exec(label)?.[1] ?? NaN)
            chapters.push({ id: id, number: number, name: label, time: relativeDate(option.attr('data-added') ?? '') })
        }
        // A one-chapter book may have no picker; its reader link names the chapter.
        if (chapters.length === 0) {
            const id = /\/reader\/\d+[^/]*\/(\d+)\//.exec($('a[href*="/reader/"]').first().attr('href') ?? '')?.[1]
            if (id != undefined) chapters.push({ id: id, number: 1, name: 'Chapter 1' })
        }

        const book: Book = {
            id: mangaId,
            title: ($('h1#book-title').first().text() || $('h1').first().text()).replace(/\s+/g, ' ').trim() || mangaId,
            cover: $('[data-book-cover] img').first().attr('src') ?? $('meta[property="og:image"]').attr('content') ?? '',
            type: names('type')[0] ?? '',
            status: names('status')[0] ?? '',
            artists: names('artist').filter((name) => !/^unknown$/i.test(name)),
            parodies: names('parody'),
            tags: tags,
            chapters: chapters
        }
        book.refusal = this.refusalOf(book)
        return book
    }

    private refusalOf(book: Book): string | undefined {
        const labels = book.tags.map((tag) => tag.name)

        const banned = book.tags.find((tag) => BANNED_TAG_IDS.includes(tag.id) || bannedName(tag.name))
        if (banned != undefined) return `This title is filed under "${banned.name}", which is excluded by your settings, and will not be shown.`

        if (groupRefusal(labels) != undefined) return GROUP_REFUSAL_MESSAGE

        const parody = book.parodies.find((name) => !/^original/i.test(name))
        if (parody != undefined) return `This title is a parody (${parody}), which your settings exclude, and will not be shown.`
        if (REFUSED_TYPES.test(book.type)) return `This title is filed as "${book.type}", which your settings exclude, and will not be shown.`

        if (BANNED_LABELS.test(book.title)) return 'This title carries content excluded by your settings and will not be shown.'
        return undefined
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const book = await this.book(mangaId)
        if (book.refusal != undefined) throw new Error(book.refusal)

        const tags: Tag[] = book.tags.map((tag) => App.createTag({ id: tag.id, label: tag.name }))

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [book.title],
                image: book.cover,
                desc: '',
                status: /completed/i.test(book.status) ? 'Completed' : 'Ongoing',
                author: book.artists.join(', '),
                artist: book.artists.join(', '),
                tags: tags.length > 0
                    ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })]
                    : []
            })
        })
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const book = await this.book(mangaId)
        if (book.refusal != undefined) throw new Error(book.refusal)

        // Oldest first; an unnumbered chapter keeps the site's order.
        const rows = book.chapters.map((chapter, index) => ({ chapter: chapter, order: -index }))
        rows.sort((a, b) => (!isNaN(a.chapter.number) && !isNaN(b.chapter.number))
            ? a.chapter.number - b.chapter.number
            : a.order - b.order)

        return rows.map((row, index) => App.createChapter({
            id: row.chapter.id,
            chapNum: isNaN(row.chapter.number) ? index + 1 : row.chapter.number,
            name: row.chapter.name,
            langCode: '🇬🇧',
            sortingIndex: index,
            ...(row.chapter.time != undefined ? { time: row.chapter.time } : {})
        }))
    }

    /**
     * The reader ships its page list as JSON: `<script type="application/json"
     * data-reader-data>{"images": [...]}`.
     */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        // Chapters saved before the rebuild are numbered ("1", "2.5") rather
        // than ids; a short id is looked up, and found again by number when it
        // is not one of the book's own.
        let chapter = chapterId
        if (!/^\d{4,}$/.test(chapterId)) {
            const book = await this.book(mangaId)
            if (book.refusal != undefined) throw new Error(book.refusal)
            const match = book.chapters.find((row) => row.id === chapterId)
                ?? book.chapters.find((row) => row.number === Number(chapterId))
                ?? (book.chapters.length === 1 ? book.chapters[0] : undefined)
            if (match == undefined) throw new Error(`No pages were found for ${mangaId}/${chapterId}.`)
            chapter = match.id
        }

        const html = await this.fetchText(`${HH_DOMAIN}/reader/${bookId(mangaId)}/${chapter}/page-1`)
        const $ = cheerio.load(html)

        let pages: string[] = []
        try {
            const data = JSON.parse($('script[data-reader-data]').first().html() ?? '{}') as { images?: string[] }
            pages = (data.images ?? []).filter((url) => typeof url === 'string' && url.length > 0)
        } catch {
            // Fall through to the page markup.
        }
        if (pages.length === 0) {
            pages = [...html.matchAll(/https:\\?\/\\?\/[^"'\s]+?\/\d{3,4}\.(?:webp|jpe?g|png)/g)]
                .map((match) => (match[0] as string).replace(/\\\//g, '/'))
                .filter((url, index, list) => !url.includes('/thumbnails/') && list.indexOf(url) === index)
        }

        if (pages.length === 0) {
            throw new Error(`No pages were found for ${mangaId}/${chapterId}.`)
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    async getSearchResults(query: SearchRequest, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const seen = new Set(metadata?.seen ?? [])

        // Tag ids from before the rebuild came T-prefixed; both forms work.
        const numeric = (tags: { id: string }[] | undefined): string[] =>
            (tags ?? []).map((tag) => tag.id.replace(/^T/, '')).filter((id) => /^\d+$/.test(id))

        const title = (query.title ?? '').trim()
        const url = await this.searchUrl({
            q: title,
            sort: title.length > 0 ? undefined : 'latest',
            include: numeric(query.includedTags),
            exclude: numeric(query.excludedTags)
        }, page)

        return this.listing(url, page, seen)
    }

    /**
     * Exclusion is offered: the site's search takes tags to leave out, and the
     * reader's choices are added to the standing exclusion rather than
     * replacing it.
     */
    async supportsTagExclusion(): Promise<boolean> {
        return true
    }

    /** The site's tag index, alphabetical, with everything excluded left off the offer. */
    async getSearchTags(): Promise<TagSection[]> {
        let catalog: { id: number; name: string }[]
        try {
            catalog = await this.loadCatalog()
        } catch {
            return []
        }

        const tags: Tag[] = catalog
            .filter((tag) => !BANNED_TAG_IDS.includes(String(tag.id)) && !bannedName(tag.name) && !/^doujinshi$/i.test(tag.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((tag) => App.createTag({ id: String(tag.id), label: tag.name }))

        return tags.length > 0 ? [App.createTagSection({ id: 'tags', label: 'Tags', tags: tags })] : []
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Reported once each, only after items are attached: a section whose
        // `items` is unset crashes the app when it reads the list.
        for (const entry of SECTIONS) {
            const section = App.createHomeSection({
                id: entry.id,
                title: entry.label,
                type: HomeSectionType.singleRowNormal,
                containsMoreItems: true,
                items: []
            })

            const html = await this.fetchText(await this.searchUrl({ sort: entry.sort }, 1))
            section.items = this.parseCards(html, new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const sort = (SECTIONS.find((entry) => entry.id === homepageSectionId) ?? SECTIONS[0]!).sort
        return this.listing(await this.searchUrl({ sort: sort }, page), page, new Set(metadata?.seen ?? []))
    }
}
