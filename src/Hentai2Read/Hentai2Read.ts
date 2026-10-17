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

import { GROUP_REFUSAL_MESSAGE, groupRefusal, TAG_ONLY_LABELS } from '../NHentai/ContentRules'

export const H2R_DOMAIN = 'https://hentai2read.com'

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
 * The same exclusions as this site's own tag ids -- its own numbering, not
 * hentaihere's -- sent as `without=` on every listing so the server leaves
 * them out and pages come back full. Resolved by name from the site's tag
 * index (/search/tags, Oct 2026); any tag added later is caught by name on the
 * card and at the details gate, and joins this list once the index has been
 * read (see bannedIds).
 */
const BANNED_TAG_IDS = [
    '10', // Tentacles
    '12', // Yaoi
    '53', // Crossdressing
    '54', // Trap
    '60', // Dog Girls
    '71', // Bestiality
    '96', // Gang Rape
    '112', // Gangbang
    '115', // Rabbit Girls
    '143', // Reverse Harem
    '177', // Ganguro
    '242', // Cat Girls
    '369', // Monsters
    '403', // Monster Sex
    '418', // Fox Girls
    '466', // Cow Girls
    '486', // Monster Girls
    '489', // Wolf Girls
    '605', // Threesome (MMF)
    '1194', // Furry
    '1210', // Old Man
    '1630', // Lizard Girl
    '1640', // Insect
    '12100', // Centaur
    '12101', // Orc
    '12103', // Josou seme
    '12115' // Slime Girls
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
    { id: 'latest', label: 'Latest Updated', sort: 'latest' },
    { id: 'newest', label: 'Newest', sort: 'newest' },
    { id: 'popular', label: 'Most Popular', sort: 'most-viewed' }
]

interface ListingMetadata {
    page?: number
    seen?: string[]
}

/** A listing entry as the page data carries it; tags are `[id, name, slug, isCategory]`. */
interface CardData {
    id: number
    title: string
    cover?: string
    type?: string
    tags?: [number, string, string, number][]
}

interface TagData {
    id: number
    name: string
    type?: string
}

interface BookData {
    id: number
    title: string
    alt?: string | null
    cover?: string
    type?: { label?: string }
    status?: { label?: string }
    description?: string | null
    tags?: TagData[]
    groups?: { label?: string; type?: string; tags?: TagData[] }[]
    isVideo?: boolean
}

interface ChapterData {
    id: number
    number?: string
    title?: string
    date?: string
    isMembers?: boolean
}

/** What the server embeds in every page: `<script data-page="app">` holding the page's props. */
interface PageData {
    component?: string
    props?: {
        books?: { data?: CardData[]; page?: number; lastPage?: number; links?: { next?: string | null } }
        book?: BookData
        chapters?: ChapterData[]
        images?: string[]
    }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Oct 13, 2026", parsed by hand rather than trusting the engine's Date.parse. */
const chapterDate = (text: string | undefined): Date | undefined => {
    const match = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(text ?? '')
    if (match == undefined) return undefined
    const month = MONTHS.indexOf((match[1] as string).toLowerCase())
    return month < 0 ? undefined : new Date(Number(match[3]), month, Number(match[2]))
}

const absolute = (url: string | undefined): string => {
    const trimmed = (url ?? '').trim()
    if (trimmed.startsWith('//')) return `https:${trimmed}`
    if (trimmed.startsWith('/')) return `${H2R_DOMAIN}${trimmed}`
    return trimmed
}

/**
 * hentai2read.com, filtered.
 *
 * The site was rebuilt in October 2026 on the same software as hentaihere --
 * series at /{type}/{id}-{slug}, the reader at /reader/{id}-{slug}/{chapter} --
 * and every page now embeds its data as JSON, which is what is read here. The
 * old /{slug}/ addresses redirect to the new pages, so library entries saved
 * before the rebuild still open under their old slug ids; new entries use the
 * book's number.
 *
 * Listings come from /search, which takes tags to include (`with`) and leave
 * out (`without`) and so does the standing exclusions server-side. Each card
 * names its tags too, so the rules are checked again before a card is shown,
 * and the details gate backstops both.
 *
 * The site sits behind a Cloudflare check, so the first visit may ask for the
 * cloud icon.
 */
export const Hentai2ReadInfo: SourceInfo = {
    version: '2.0.0',
    name: 'Hentai2Read (Filtered)',
    icon: 'icon.png',
    author: 'Shmowzy27',
    authorWebsite: 'https://github.com/Shmowzy27',
    description: 'Extension that pulls content from hentai2read.com with the standing content exclusions applied.',
    contentRating: ContentRating.ADULT,
    websiteBaseURL: H2R_DOMAIN,
    sourceTags: [
        {
            text: '18+',
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class Hentai2Read implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {
    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 30000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${H2R_DOMAIN}/`,
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

    /** A book number opens /original/{id}, which redirects to its real type; an old slug opens /{slug}/. */
    getMangaShareUrl(mangaId: string): string {
        return /^\d+$/.test(mangaId) ? `${H2R_DOMAIN}/original/${mangaId}` : `${H2R_DOMAIN}/${mangaId}/`
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${H2R_DOMAIN}/`,
            method: 'GET',
            headers: {
                'referer': `${H2R_DOMAIN}/`,
                'user-agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    private cloudflareError(): Error {
        return new Error(`CLOUDFLARE BYPASS ERROR:\nPlease go to the homepage of <${Hentai2ReadInfo.name}> and press the cloud icon.`)
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

    private async fetchPage(url: string): Promise<PageData> {
        const html = await this.fetchText(url)
        const json = /<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
        if (json == undefined) throw new Error('The site answered with a page this source does not recognise.')
        return JSON.parse(json) as PageData
    }

    /** The tag index, `{id, name, count}` per tag, read once per session. */
    private catalog: { id: number; name: string }[] | undefined

    private async loadCatalog(): Promise<{ id: number; name: string }[]> {
        if (this.catalog != undefined) return this.catalog
        const parsed = JSON.parse(await this.fetchText(`${H2R_DOMAIN}/search/tags`)) as { id: number; name: string }[]
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
        return `${H2R_DOMAIN}/search?${params.join('&')}`
    }

    /** Listing entries, each held to the rules on its own tags before it is shown. */
    private tilesFrom(data: PageData, seen: Set<string>): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []

        for (const card of data.props?.books?.data ?? []) {
            const id = String(card.id ?? '')
            const title = (card.title ?? '').replace(/\s+/g, ' ').trim()
            if (!/^\d+$/.test(id) || title.length === 0 || seen.has(id)) continue
            if (REFUSED_TYPES.test(card.type ?? '')) continue

            const tags = card.tags ?? []
            const labels = tags.map((tag) => tag[1])
            if (tags.some((tag) => BANNED_TAG_IDS.includes(String(tag[0])) || bannedName(tag[1]))) continue
            if (groupRefusal(labels) != undefined || BANNED_LABELS.test(title)) continue

            seen.add(id)
            tiles.push(App.createPartialSourceManga({ mangaId: id, image: absolute(card.cover), title: title }))
        }

        return tiles
    }

    private hasNextPage(data: PageData): boolean {
        const books = data.props?.books
        if (books?.links?.next != undefined) return true
        return books?.page != undefined && books.lastPage != undefined && books.page < books.lastPage
    }

    private async listing(url: string, page: number, seen: Set<string>): Promise<PagedResults> {
        const data = await this.fetchPage(url)
        return App.createPagedResults({
            results: this.tilesFrom(data, seen),
            metadata: this.hasNextPage(data) ? { page: page + 1, seen: Array.from(seen) } : undefined
        })
    }

    /** A series page's data, judged by the standing rules. */
    private async book(mangaId: string): Promise<{ book: BookData; chapters: ChapterData[]; refusal?: string }> {
        const data = await this.fetchPage(this.getMangaShareUrl(mangaId))
        const book = data.props?.book
        if (book == undefined) throw new Error(`${mangaId} is not a series on the site.`)
        return { book: book, chapters: data.props?.chapters ?? [], refusal: this.refusalOf(book) }
    }

    private names(book: BookData, type: string): string[] {
        return (book.groups ?? [])
            .filter((group) => group.type === type)
            .flatMap((group) => (group.tags ?? []).map((tag) => tag.name.trim()))
            .filter((name) => name.length > 0)
    }

    private refusalOf(book: BookData): string | undefined {
        const tags = book.tags ?? []
        const labels = tags.map((tag) => tag.name)

        const banned = tags.find((tag) => BANNED_TAG_IDS.includes(String(tag.id)) || bannedName(tag.name))
        if (banned != undefined) return `This title is filed under "${banned.name}", which is excluded by your settings, and will not be shown.`

        if (groupRefusal(labels) != undefined) return GROUP_REFUSAL_MESSAGE

        const parody = this.names(book, 'parody').find((name) => !/^original/i.test(name))
        if (parody != undefined) return `This title is a parody (${parody}), which your settings exclude, and will not be shown.`
        const type = book.type?.label ?? ''
        if (REFUSED_TYPES.test(type) || book.isVideo === true) {
            return `This title is filed as "${type || 'Video'}", which your settings exclude, and will not be shown.`
        }

        if (BANNED_LABELS.test(book.title)) return 'This title carries content excluded by your settings and will not be shown.'
        return undefined
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const { book, refusal } = await this.book(mangaId)
        if (refusal != undefined) throw new Error(refusal)

        const titles = [book.title.trim()]
        const alt = (book.alt ?? '').trim()
        if (alt.length > 0 && !titles.includes(alt)) titles.push(alt)

        const artists = this.names(book, 'artist').filter((name) => !/^unknown$/i.test(name))
        const tags: Tag[] = (book.tags ?? []).map((tag) => App.createTag({ id: String(tag.id), label: tag.name }))

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: titles,
                image: absolute(book.cover),
                desc: (book.description ?? '').trim(),
                status: /completed/i.test(book.status?.label ?? '') ? 'Completed' : 'Ongoing',
                author: artists.join(', '),
                artist: artists.join(', '),
                tags: tags.length > 0
                    ? [App.createTagSection({ id: 'category', label: 'Categories', tags: tags })]
                    : []
            })
        })
    }

    /** The book's chapters, oldest first; members-only ones cannot be read and are left out. */
    private ordered(chapters: ChapterData[]): { id: string; number: number; name: string; time?: Date }[] {
        const rows = chapters
            .filter((chapter) => chapter.isMembers !== true && chapter.id != undefined)
            .map((chapter, index) => ({
                id: String(chapter.id),
                number: Number(chapter.number ?? NaN),
                name: (chapter.title ?? '').replace(/\s+/g, ' ').trim(),
                time: chapterDate(chapter.date),
                order: index
            }))
        rows.sort((a, b) => (!isNaN(a.number) && !isNaN(b.number)) ? a.number - b.number : a.order - b.order)
        return rows
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const { chapters, refusal } = await this.book(mangaId)
        if (refusal != undefined) throw new Error(refusal)

        return this.ordered(chapters).map((row, index) => App.createChapter({
            id: row.id,
            chapNum: isNaN(row.number) ? index + 1 : row.number,
            name: row.name.length > 0 ? row.name : `Chapter ${isNaN(row.number) ? index + 1 : row.number}`,
            langCode: '🇬🇧',
            sortingIndex: index,
            ...(row.time != undefined ? { time: row.time } : {})
        }))
    }

    /** The reader's page data carries the page list as `images`. */
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        // An old slug id needs the book's number for the reader's address, and
        // a chapter saved before the rebuild is numbered ("1", "2.5") rather
        // than identified: both are looked up on the book's own page.
        let book = mangaId
        let chapter = chapterId
        if (!/^\d+$/.test(mangaId) || !/^\d{4,}$/.test(chapterId)) {
            const found = await this.book(mangaId)
            if (found.refusal != undefined) throw new Error(found.refusal)
            book = String(found.book.id)

            if (!/^\d{4,}$/.test(chapterId)) {
                const rows = this.ordered(found.chapters)
                const match = rows.find((row) => row.id === chapterId)
                    ?? rows.find((row) => row.number === Number(chapterId))
                    ?? (rows.length === 1 ? rows[0] : undefined)
                if (match == undefined) throw new Error(`No pages were found for ${mangaId}/${chapterId}.`)
                chapter = match.id
            }
        }

        const data = await this.fetchPage(`${H2R_DOMAIN}/reader/${book}/${chapter}/page-1`)
        const pages = (data.props?.images ?? []).filter((url) => typeof url === 'string' && url.length > 0).map(absolute)

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

        // Category ids from before the rebuild were names ("cat:Incest"); they
        // name nothing in the new index and are dropped.
        const numeric = (tags: { id: string }[] | undefined): string[] =>
            (tags ?? []).map((tag) => tag.id).filter((id) => /^\d+$/.test(id))

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

        return tags.length > 0 ? [App.createTagSection({ id: 'category', label: 'Categories', tags: tags })] : []
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

            section.items = this.tilesFrom(await this.fetchPage(await this.searchUrl({ sort: entry.sort }, 1)), new Set<string>())
            sectionCallback(section)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: ListingMetadata | undefined): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const sort = (SECTIONS.find((entry) => entry.id === homepageSectionId) ?? SECTIONS[0]!).sort
        return this.listing(await this.searchUrl({ sort: sort }, page), page, new Set(metadata?.seen ?? []))
    }
}
