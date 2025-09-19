import { useMemo, useState } from 'react'
import { Calendar as RBC, dateFnsLocalizer, View, Views } from 'react-big-calendar'
import { addDays, addMonths, addWeeks, endOfDay, format, parse, startOfDay, startOfWeek as dfStartOfWeek, getDay as dfGetDay } from 'date-fns'
import { Upload, CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import * as XLSX from 'xlsx'
import 'react-big-calendar/lib/css/react-big-calendar.css'

type BosRow = {
  'Order Number': string
  'Order Date'?: string | number
  'Delivery Date'?: string | number
  'Dispatch Date'?: string | number
  'Packing Date'?: string | number
  'Order Status'?: string
  'Customer Name'?: string
  'Customer Email'?: string
  'Customer Phone'?: string
  'Billing Address'?: string
  'Billing City'?: string
  'Billing State'?: string
  'Billing Pincode'?: string | number
  'Shipping Address'?: string
  'Shipping City'?: string
  'Shipping State'?: string
  'Shipping Pincode'?: string | number
  'Rack'?: string
  'Offline Order Items'?: string
  'Notes'?: string
  'Gift Message'?: string
  'Channel'?: string
  'Area'?: string
  [key: string]: unknown
}

type OrderEvent = {
  title: string
  start: Date
  end: Date
  resource: BosRow
}

const locales = {}
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: dfStartOfWeek,
  getDay: dfGetDay,
  locales,
})

function isExcelDate(value: unknown): boolean {
  // NEVER treat numbers as Excel dates - all dates should be DD-MM-YY strings
  // This prevents Excel from misinterpreting DD-MM-YY as MM-DD-YY
  return false
}

function excelDateToJSDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569)
  const utcValue = utcDays * 86400
  const dateInfo = new Date(utcValue * 1000)
  const fractionalDay = serial - Math.floor(serial)
  const totalSeconds = Math.floor(86400 * fractionalDay)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  dateInfo.setHours(hours, minutes, seconds)
  return dateInfo
}

function convertExcelSerialToDDMMYY(serial: number): string | null {
  // Convert Excel serial to JavaScript date
  const jsDate = new Date((serial - 25569) * 86400 * 1000)
  const day = jsDate.getDate()
  const month = jsDate.getMonth() + 1 // 0-indexed to 1-indexed
  const year = jsDate.getFullYear()
  
  // Format as DD-MM-YY
  const dd = day.toString().padStart(2, '0')
  const mm = month.toString().padStart(2, '0')
  const yy = (year % 100).toString().padStart(2, '0')
  
  return `${dd}-${mm}-${yy}`
}

function parseStrictDDMMYY(value: string): Date | null {
  const shouldDebug = value === '10-03-25' || value.includes('03-25') || value.includes('10-03')
  if (shouldDebug) console.log(`🔍 parseStrictDDMMYY called with: "${value}"`)
  
  const m = value.match(/^(\d{2})-(\d{2})-(\d{2})$/)
  if (!m) {
    if (shouldDebug) console.log(`❌ parseStrictDDMMYY: No match for pattern DD-MM-YY`)
    return null
  }
  const dd = Number(m[1])
  const mm = Number(m[2])
  const yy = Number(m[3])
  if (shouldDebug) console.log(`📅 parseStrictDDMMYY: Parsed dd=${dd}, mm=${mm}, yy=${yy}`)
  
  if (mm < 1 || mm > 12) {
    if (shouldDebug) console.log(`❌ parseStrictDDMMYY: Invalid month ${mm}`)
    return null
  }
  if (dd < 1 || dd > 31) {
    if (shouldDebug) console.log(`❌ parseStrictDDMMYY: Invalid day ${dd}`)
    return null
  }
  const year = 2000 + yy
  const d = new Date(year, mm - 1, dd)
  if (shouldDebug) console.log(`📅 parseStrictDDMMYY: Created date: ${d.toDateString()}`)
  
  if (d.getFullYear() !== year || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
    if (shouldDebug) console.log(`❌ parseStrictDDMMYY: Date validation failed`)
    return null
  }
  const result = startOfDay(d)
  if (shouldDebug) console.log(`✅ parseStrictDDMMYY: Returning ${result.toDateString()}`)
  return result
}

function normalizeDate(value: unknown): Date | null {
  const shouldDebug = typeof value === 'string' && (value === '10-03-25' || value.includes('03-25') || value.includes('10-03'))
  if (shouldDebug) console.log(`🚀 normalizeDate called with:`, value, `(type: ${typeof value})`)
  
  if (!value) {
    if (shouldDebug) console.log(`❌ normalizeDate: No value provided`)
    return null
  }
  
  // Handle Excel serial numbers by converting them to DD-MM-YY format
  if (typeof value === 'number' && value > 25000 && value < 100000) {
    if (shouldDebug) console.log(`🔄 normalizeDate: Converting Excel serial ${value} to DD-MM-YY format`)
    const dateString = convertExcelSerialToDDMMYY(value)
    if (dateString) {
      if (shouldDebug) console.log(`🔄 normalizeDate: Converted to: "${dateString}"`)
      return parseStrictDDMMYY(dateString)
    }
  }
  
  if (isExcelDate(value)) {
    if (shouldDebug) console.log(`📊 normalizeDate: Excel date detected, converting...`)
    const result = startOfDay(excelDateToJSDate(value as number))
    if (shouldDebug) console.log(`✅ normalizeDate: Excel date result: ${result.toDateString()}`)
    return result
  }
  
  if (typeof value === 'string') {
    const s = value.trim()
    if (shouldDebug) console.log(`📝 normalizeDate: Processing string: "${s}"`)
    
    // Strict DD-MM-YY first - this should handle most cases
    if (shouldDebug) console.log(`🔍 normalizeDate: Trying parseStrictDDMMYY...`)
    const strict = parseStrictDDMMYY(s)
    if (strict) {
      if (shouldDebug) console.log(`✅ normalizeDate: parseStrictDDMMYY succeeded: ${strict.toDateString()}`)
      return strict
    }
    if (shouldDebug) console.log(`❌ normalizeDate: parseStrictDDMMYY failed, trying other methods...`)

    // Only accept true ISO 8601 (yyyy-mm-dd) with Date.parse - but only for 4-digit years
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && s.length >= 10) {
      if (shouldDebug) console.log(`🌍 normalizeDate: Trying ISO date parsing for: "${s}"`)
      const iso = Date.parse(s)
      if (!Number.isNaN(iso)) {
        const result = startOfDay(new Date(iso))
        if (shouldDebug) console.log(`✅ normalizeDate: ISO date result: ${result.toDateString()}`)
        return result
      }
      if (shouldDebug) console.log(`❌ normalizeDate: ISO date parsing failed`)
    }

    // Fallback to date-fns parse for other common formats
    if (shouldDebug) console.log(`🔄 normalizeDate: Trying date-fns parse with dd-MM-yy...`)
    let parsed = parse(s, 'dd-MM-yy', new Date())
    if (!Number.isNaN(parsed.getTime())) {
      const result = startOfDay(parsed)
      if (shouldDebug) console.log(`✅ normalizeDate: dd-MM-yy result: ${result.toDateString()}`)
      return result
    }
    if (shouldDebug) console.log(`❌ normalizeDate: dd-MM-yy failed, trying dd-MM-yyyy...`)
    
    parsed = parse(s, 'dd-MM-yyyy', new Date())
    if (!Number.isNaN(parsed.getTime())) {
      const result = startOfDay(parsed)
      if (shouldDebug) console.log(`✅ normalizeDate: dd-MM-yyyy result: ${result.toDateString()}`)
      return result
    }
    if (shouldDebug) console.log(`❌ normalizeDate: dd-MM-yyyy failed, trying dd/MM/yyyy...`)
    
    parsed = parse(s, 'dd/MM/yyyy', new Date())
    if (!Number.isNaN(parsed.getTime())) {
      const result = startOfDay(parsed)
      if (shouldDebug) console.log(`✅ normalizeDate: dd/MM/yyyy result: ${result.toDateString()}`)
      return result
    }
    if (shouldDebug) console.log(`❌ normalizeDate: All parsing methods failed`)
  }
  
  if (shouldDebug) console.log(`❌ normalizeDate: Returning null - no valid date found`)
  return null
}

// Minimal fields required to render events in the calendar.
// (Kept for reference if needed)
// const REQUIRED_FIELDS: Array<keyof BosRow> = ['Order Number', 'Delivery Date']

function normalizeHeaderName(header: string): string {
  return header
    .toLowerCase()
    .replace(/\uFEFF/g, '') // strip BOM if present
    .replace(/[_\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getValueFromRow(row: Record<string, unknown>, candidates: string[]): unknown {
  const lookup = new Map<string, unknown>()
  for (const key of Object.keys(row)) {
    lookup.set(normalizeHeaderName(key), (row as any)[key])
  }
  for (const c of candidates) {
    const norm = normalizeHeaderName(c)
    if (lookup.has(norm)) return lookup.get(norm)
  }
  return undefined
}

type ParsedLineItem = {
  name: string
  quantity: number
  raw?: string
  sku?: string
}

function splitItemsList(cell: string): string[] {
  // Items often come comma-separated in one line. Also handle newlines.
  const parts = cell
    .split(/\r?\n|,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/) // split on newlines or commas not inside quotes
    .map((s) => s.trim())
    .filter(Boolean)
  return parts
}

function parseItemsFromOfflineCell(cell: string): ParsedLineItem[] {
  const items: ParsedLineItem[] = []
  for (const part of splitItemsList(cell)) {
    // Typical: "SKU-Product Name - 1" or "Product Name - 2"
    const qtyMatch = part.match(/\s-\s(\d+)\s*$/)
    let quantity = 1
    let name = part
    if (qtyMatch) {
      quantity = parseInt(qtyMatch[1] || '1', 10)
      name = part.replace(/\s-\s\d+\s*$/, '').trim()
    }
    // Keep full string; SKU vs Title will be derived later without dropping prefixes
    items.push({ name, quantity, raw: part })
  }
  return items
}

function parseItemsFromNotes(cell: string): ParsedLineItem[] {
  const items: ParsedLineItem[] = []
  const lines = cell.split(/\r?\n/)
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    // Patterns: "1 x CB 200" or "- 2 x Item" or "* Item Name" (implicit qty 1)
    let m = s.match(/^[-*]\s*(\d+)\s*x\s*(.+)$/i)
    if (m) {
      items.push({ name: m[2].trim(), quantity: parseInt(m[1], 10), raw: s })
      continue
    }
    m = s.match(/^(\d+)\s*x\s*(.+)$/i)
    if (m) {
      items.push({ name: m[2].trim(), quantity: parseInt(m[1], 10), raw: s })
      continue
    }
    m = s.match(/^[-*]\s*(.+)$/)
    if (m) {
      items.push({ name: m[1].trim(), quantity: 1, raw: s })
      continue
    }
  }
  return items
}

function getParsedLineItems(row: BosRow): ParsedLineItem[] {
  // If this event has an injected, pre-parsed items list (e.g., per-date grouping), prefer that
  const injected = (row as any)['__itemsForEvent'] as ParsedLineItem[] | undefined
  if (Array.isArray(injected) && injected.length > 0) return injected

  const offlineCell = (getValueFromRow(row as any, [
  'Offline Order Items',
    'Items',
    'Products Ordered',
    'Add Offline Order',
    'Add Order',
  ]) || '') as string
  const notesCell = (getValueFromRow(row as any, ['Notes', 'Special Instructions']) || '') as string

  let parsed: ParsedLineItem[] = []
  if (typeof offlineCell === 'string' && offlineCell.trim().length > 0) {
    parsed = parseItemsFromOfflineCell(offlineCell)
  }
  // Fallback or supplement from notes if nothing parsed
  if (parsed.length === 0 && typeof notesCell === 'string' && notesCell.trim().length > 0) {
    parsed = parseItemsFromNotes(notesCell)
  }
  // Consolidate same-name items
  const consolidated = new Map<string, number>()
  for (const it of parsed) {
    const key = it.name.toLowerCase()
    consolidated.set(key, (consolidated.get(key) || 0) + (it.quantity || 1))
  }
  return Array.from(consolidated.entries()).map(([k, qty]) => ({ name: parsed.find((p) => p.name.toLowerCase() === k)?.name || k, quantity: qty }))
}

function classifySkuAndTitle(name: string): { sku: string; title: string } {
  // Preserve all initial ALL-CAPS/number hyphen-separated segments as SKU.
  // The first segment containing lowercase starts the Title.
  const raw = name.trim()
  const tokens = raw.split(/\s*-\s*/).filter(Boolean)
  const skuParts: string[] = []
  const titleParts: string[] = []
  let inTitle = false
  for (const token of tokens) {
    const hasLowercase = /[a-z]/.test(token)
    if (!inTitle && !hasLowercase) {
      skuParts.push(token)
    } else {
      inTitle = true
      titleParts.push(token)
    }
  }
  const sku = skuParts.join('-').trim()
  const title = (titleParts.join(' - ').trim() || raw)
  return { sku, title }
}

function computeStats(row: BosRow): { hampers: number; units: number } {
  const items = getParsedLineItems(row)
  let units = 0
  let hampers = 0
  for (const it of items) {
    const q = it.quantity || 1
    units += q
    // Count hampers strictly by SKU prefixes only
    const skuPrefix = classifySkuAndTitle(it.name).sku
    const packagingSku = /^(PKG|HAMP|BOX|BAG)\b/i.test(skuPrefix)
    if (packagingSku) hampers += q
  }
  return { hampers, units }
}

function EventCell({ event }: { event: OrderEvent }) {
  const { hampers, units } = computeStats(event.resource)
  return (
    <div className="text-[11px] leading-tight">
      <div className="font-medium">{event.title}</div>
      <div className="text-gray-700">Hampers: {hampers} • Units: {units}</div>
    </div>
  )
}

type ViewMode = 'day' | 'week' | 'month'

function App() {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [currentDate, setCurrentDate] = useState<Date>(startOfDay(new Date()))
  const [view, setView] = useState<ViewMode>('month')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dateCheckerOpen, setDateCheckerOpen] = useState(false)
  const [dateCheckerInput, setDateCheckerInput] = useState('')
  const [dateCheckerResult, setDateCheckerResult] = useState<{ parsed: Date | null; formatted: string; error?: string } | null>(null)
  const [txConfig, setTxConfig] = useState<{ packers: number; collaterals: number; dispatchers: number; holders: number }>(() => {
    try {
      const raw = localStorage.getItem('tx-config')
      if (raw) return JSON.parse(raw)
    } catch {}
    return { packers: 2, collaterals: 2, dispatchers: 1, holders: 0 }
  })
  const [drawer, setDrawer] = useState<{ open: boolean; row: BosRow | null }>({ open: false, row: null })

  const rbcView: View = useMemo(() => {
    if (view === 'day') return Views.DAY
    if (view === 'week') return Views.WEEK
    if (view === 'month') return Views.MONTH
    return Views.DAY
  }, [view])

  function handleFile(file: File) {
    const isCsv = /\.csv$/i.test(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      let wb: XLSX.WorkBook
      if (isCsv) {
        const text = e.target?.result as string
        wb = XLSX.read(text, { type: 'string' })
      } else {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        wb = XLSX.read(data, { type: 'array' })
      }
      const sheetName = wb.SheetNames[0]
      const sheet = wb.Sheets[sheetName]
      const json = XLSX.utils.sheet_to_json<BosRow>(sheet, { defval: '' })
      if (json.length === 0) {
        alert('The selected file has no rows in the first sheet.')
        return
      }
      // Validate only minimal required fields using case-insensitive, flexible matching
      const headerSet = new Set((Object.keys(json[0] ?? {})).map((h) => normalizeHeaderName(h)))
      const orderNumberSynonyms = ['Order Number', 'Order No', 'Order#', 'Order Id', 'OrderID', 'Order Alias']
      const deliveryDateSynonyms = ['Delivery Date', 'Delivery Dt', 'DeliveryDate', 'Delivery', 'Dispatch Date (First)']
      const hasOrderNumber = orderNumberSynonyms.some((h) => headerSet.has(normalizeHeaderName(h)))
      const hasDeliveryDate = deliveryDateSynonyms.some((h) => headerSet.has(normalizeHeaderName(h)))
      if (!hasOrderNumber || !hasDeliveryDate) {
        alert('This file must include at least Order Number and Delivery Date columns.')
        return
      }
      // Some sheets provide items with a leading date token per item like "22-09-25-SKU-Name-Qty".
      // For such rows, split items by the leading date and create separate events per date.
      const eventsOut: OrderEvent[] = []
      for (const r of json as any[]) {
        const orderNumber = getValueFromRow(r, ['Order Number', 'Order No', 'Order#', 'Order Id', 'OrderID', 'Order Alias'])
        const deliveryRawFallback = getValueFromRow(r, ['Delivery Date', 'Delivery Dt', 'DeliveryDate', 'Delivery', 'Dispatch Date (First)'])
        
        // Debug logging for specific problematic order
        if (String(orderNumber).includes('Sample_Puma_NB') || String(deliveryRawFallback).includes('10-03-25')) {
          console.log(`🎯 DEBUG: Processing order: ${orderNumber}`)
          console.log(`📋 Raw row data:`, r)
          console.log(`🔍 Order Number found:`, orderNumber)
          console.log(`📅 Delivery Date raw value:`, deliveryRawFallback)
          console.log(`📅 Delivery Date type:`, typeof deliveryRawFallback)
        }
        
        if (!orderNumber) continue
        const allItemsCell = String(
          (getValueFromRow(r, ['Add Offline Order', 'Add Order']) as any) ||
          (getValueFromRow(r, ['Offline Order Items', 'Items', 'Products Ordered']) as any) ||
          ''
        )

        // Detect per-item date pattern at the start: DD-MM-YY-...
        const parts = splitItemsList(allItemsCell)
        const datedGroups = new Map<string, string[]>()
        for (const p of parts) {
          const m = p.match(/^(\d{2}-\d{2}-\d{2})-(.+)$/)
          if (m) {
            const d = m[1]
            const rest = m[2]
            if (!datedGroups.has(d)) datedGroups.set(d, [])
            datedGroups.get(d)!.push(rest)
          }
        }

        if (datedGroups.size > 0) {
          // Build one event per date using grouped items
          for (const [dstr, items] of Array.from(datedGroups.entries())) {
            const delivery = normalizeDate(dstr)
            if (!delivery) continue
            const resource: BosRow = { ...(r as any) }
            ;(resource as any)['Order Number'] = String(orderNumber)
            ;(resource as any)['Delivery Date'] = dstr
            ;(resource as any)['__itemsForEvent'] = parseItemsFromOfflineCell(items.join(', '))
            eventsOut.push({
              title: String(orderNumber),
              start: startOfDay(delivery),
              end: endOfDay(delivery),
              resource,
            })
          }
        } else {
          // Fallback: single delivery date field
          const delivery = normalizeDate(deliveryRawFallback)
          
          // Debug logging for specific problematic order
          if (String(orderNumber).includes('Sample_Puma_NB') || String(deliveryRawFallback).includes('10-03-25')) {
            console.log(`🎯 DEBUG: normalizeDate result for ${orderNumber}:`, delivery)
            console.log(`🎯 DEBUG: delivery date string:`, delivery?.toDateString())
            console.log(`🎯 DEBUG: delivery date ISO:`, delivery?.toISOString())
          }
          
          if (!delivery) {
            console.log(`❌ No valid delivery date found for order: ${orderNumber}`)
            continue
          }
          
          const resource: BosRow = { ...(r as any) }
          ;(resource as any)['Order Number'] = String(orderNumber)
          ;(resource as any)['Delivery Date'] = deliveryRawFallback as any
          
          const event = {
            title: String(orderNumber),
            start: startOfDay(delivery),
            end: endOfDay(delivery),
            resource,
          }
          
          // Debug logging for specific problematic order
          if (String(orderNumber).includes('Sample_Puma_NB') || String(deliveryRawFallback).includes('10-03-25')) {
            console.log(`🎯 DEBUG: Created event for ${orderNumber}:`, event)
            console.log(`🎯 DEBUG: Event start date:`, event.start.toDateString())
            console.log(`🎯 DEBUG: Event start month:`, event.start.getMonth() + 1)
            console.log(`🎯 DEBUG: Event start year:`, event.start.getFullYear())
          }
          
          eventsOut.push(event)
        }
      }
      const mapped = eventsOut
      setEvents(mapped)
    }
    if (isCsv) reader.readAsText(file)
    else reader.readAsArrayBuffer(file)
  }

  const [dragOver, setDragOver] = useState(false)

  const eventStyleGetter = (event: OrderEvent) => {
    const status = (event.resource['Order Status'] || '').toString().toLowerCase()
    // Lighter backgrounds for better text legibility
    let bg = '#e2e8f0' // slate-200
    if (status.includes('pending')) bg = '#fde68a' // amber-200
    else if (status.includes('printed')) bg = '#c7d2fe' // indigo-200
    else if (status.includes('packed')) bg = '#bbf7d0' // green-200
    else if (status.includes('shipped')) bg = '#bfdbfe' // blue-200
    else if (status.includes('cancel')) bg = '#fecaca' // red-200
    return { style: { backgroundColor: bg, border: '1px solid #cbd5e1', color: '#111827' } }
  }

  const handleNavigate = (action: 'prev' | 'next' | 'today') => {
    if (action === 'today') setCurrentDate(startOfDay(new Date()))
    else if (action === 'prev') {
      if (view === 'day') setCurrentDate(addDays(currentDate, -1))
      else if (view === 'week') setCurrentDate(addWeeks(currentDate, -1))
      else setCurrentDate(addMonths(currentDate, -1))
    } else if (action === 'next') {
      if (view === 'day') setCurrentDate(addDays(currentDate, 1))
      else if (view === 'week') setCurrentDate(addWeeks(currentDate, 1))
      else setCurrentDate(addMonths(currentDate, 1))
    }
  }

  const testDateParsing = (input: string) => {
    try {
      const parsed = normalizeDate(input)
      if (parsed) {
        setDateCheckerResult({
          parsed,
          formatted: format(parsed, 'dd-MM-yy'),
          error: undefined
        })
      } else {
        setDateCheckerResult({
          parsed: null,
          formatted: '',
          error: 'Could not parse date'
        })
      }
    } catch (error) {
      setDateCheckerResult({
        parsed: null,
        formatted: '',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div className="flex h-full flex-col bg-white text-gray-900">
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-xl font-semibold">
          <CalendarDays className="h-6 w-6" />
          <span>Packing Assistant</span>
        </div>
        <div className="ml-6 hidden rounded-full bg-gray-100 p-1 text-sm md:flex">
          {['Packers', 'Collateral', 'Holders', 'Dispatchers'].map((role) => (
            <button key={role} className="rounded-full px-3 py-1.5 hover:bg-white">
              {role}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden rounded-md border md:flex">
            {(
              [
                { k: 'day', label: 'Day' },
                { k: 'week', label: 'Week' },
                { k: 'month', label: 'Month' },
              ] as Array<{ k: ViewMode; label: string }>
            ).map(({ k, label }) => (
              <button
                key={k}
                onClick={() => setView(k)}
                className={`px-3 py-1.5 ${view === k ? 'bg-gray-100' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="rounded border px-3 py-1" onClick={() => setSettingsOpen(true)}>Settings</button>
          <button className="rounded border px-3 py-1" onClick={() => setDateCheckerOpen(true)}>Date Checker</button>
          <div className="flex items-center gap-1">
            <button className="rounded border p-1" onClick={() => handleNavigate('prev')}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button className="rounded border p-1" onClick={() => handleNavigate('today')}>
              Today
            </button>
            <button className="rounded border p-1" onClick={() => handleNavigate('next')}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <label className="ml-2 inline-flex cursor-pointer items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Upload className="h-4 w-4" />
            <span>Upload</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFileChange} />
          </label>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden md:flex md:flex-row">
        {/* Calendar column */}
      <div
          className={`relative h-full w-full md:w-3/4 ${events.length === 0 ? 'grid place-items-center' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {events.length === 0 ? (
          <div className="mx-4 max-w-xl rounded-lg border bg-white p-8 text-center shadow-sm">
            <p className="text-lg font-medium">Upload your Bulk Order Sheet (CSV/XLSX) to view orders.</p>
            <p className="mt-2 text-sm text-gray-600">Drag & drop or use the Upload button above.</p>
          </div>
        ) : (
          <div className="h-full">
            <RBC
              localizer={localizer}
              events={events}
              startAccessor="start"
              endAccessor="end"
              date={currentDate}
              view={rbcView}
              onNavigate={(d: Date) => setCurrentDate(startOfDay(d))}
              onView={() => {}}
              eventPropGetter={eventStyleGetter}
              onSelectEvent={(e: any) => {
                setDrawer({ open: true, row: e.resource })
                if (e?.start) setCurrentDate(startOfDay(new Date(e.start)))
              }}
                components={{ event: EventCell as any }}
              popup
                length={undefined}
              style={{ height: '100%' }}
            />
          </div>
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-blue-500/10">
            <div className="rounded-lg border-2 border-dashed border-blue-500 bg-white/80 p-6 text-blue-700">
              Drop file to import BOS
            </div>
          </div>
        )}
      </div>
        {/* Preview column */}
        <aside className="hidden h-full w-full overflow-y-auto border-l md:block md:w-1/4">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="text-xl font-bold">{drawer.row?.['Order Number'] || 'Preview'}</div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {drawer.row ? (
                <>
              <div className="mb-4">
                <StatusPill status={(drawer.row['Order Status'] || '') as string} />
              </div>
              <Section title="Key Dates">
                    {(() => {
                      // Debug logging for Sample_Puma_NB
                      if (String(drawer.row['Order Number']).includes('Sample_Puma_NB')) {
                        console.log(`🎯 KEY DATES DEBUG for Sample_Puma_NB:`)
                        console.log(`  Raw Delivery Date:`, drawer.row['Delivery Date'])
                        console.log(`  Raw Dispatch Date:`, drawer.row['Dispatch Date'])
                        console.log(`  Raw Packing Date:`, drawer.row['Packing Date'])
                      }
                      
                      const delivery = normalizeDate(drawer.row['Delivery Date'])
                      const dispatch = normalizeDate(drawer.row['Dispatch Date']) || (delivery ? addDays(delivery, -Math.max(1, Number((txConfig as any).dispatchers ?? 1))) : null)
                      const packing = normalizeDate(drawer.row['Packing Date']) || (delivery ? addDays(delivery, -Math.max(1, Number((txConfig as any).packers ?? 2))) : null)
                      
                      if (String(drawer.row['Order Number']).includes('Sample_Puma_NB')) {
                        console.log(`  Parsed Delivery Date:`, delivery)
                        console.log(`  Parsed Dispatch Date:`, dispatch)
                        console.log(`  Parsed Packing Date:`, packing)
                      }
                      
                      return (
                        <>
                          <KeyDate label="Delivery Date" value={delivery || drawer.row['Delivery Date']} strong />
                          <KeyDate label="Dispatch Date" value={dispatch} />
                          <KeyDate label="Packing Date" value={packing} />
                        </>
                      )
                    })()}
              </Section>
              <Section title="Rack">
                {drawer.row['Rack'] ? (
                  <div className="rounded bg-gray-100 px-3 py-2 font-medium">{drawer.row['Rack']}</div>
                ) : (
                  <div className="text-red-600">No Rack assigned</div>
                )}
              </Section>
              <Section title="Customer">
                <div className="space-y-1">
                  <div className="font-medium">{drawer.row['Customer Name']}</div>
                  <div className="text-sm text-gray-600">{drawer.row['Customer Email']}</div>
                  <div className="text-sm text-gray-600">{drawer.row['Customer Phone']}</div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="text-sm font-medium text-gray-700">Billing</div>
                    <div className="text-sm text-gray-800">
                      {drawer.row['Billing Address']}
                      <div>
                        {drawer.row['Billing City']}, {drawer.row['Billing State']} {drawer.row['Billing Pincode']}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-700">Shipping</div>
                    <div className="text-sm text-gray-800">
                      {drawer.row['Shipping Address']}
                      <div>
                        {drawer.row['Shipping City']}, {drawer.row['Shipping State']} {drawer.row['Shipping Pincode']}
                      </div>
                    </div>
                  </div>
                </div>
              </Section>
              <Section title="Items">
                    {(() => {
                      const items = getParsedLineItems(drawer.row)
                      if (items.length === 0) {
                        return (
                          <pre className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">{String(
                            (drawer.row['Offline Order Items'] as unknown as string) || drawer.row['Notes'] || '-'
                          )}</pre>
                        )
                      }
                      const rows = items.map((it) => {
                        const { sku, title } = classifySkuAndTitle(it.name)
                        return { sku, title, qty: it.quantity }
                      })
                      return (
                        <div className="overflow-hidden rounded border">
                          <table className="w-full text-sm">
                            <thead className="bg-gray-50 text-left text-gray-600">
                              <tr>
                                <th className="px-3 py-2 w-36">SKU</th>
                                <th className="px-3 py-2">Item</th>
                                <th className="px-3 py-2 w-20 text-right">Qty</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, idx) => (
                                <tr key={idx} className={idx % 2 ? 'bg-white' : 'bg-gray-50/40'}>
                                  <td className="px-3 py-2 text-xs text-gray-600">{r.sku}</td>
                                  <td className="px-3 py-2">{r.title}</td>
                                  <td className="px-3 py-2 text-right font-medium">{r.qty}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    })()}
              </Section>
              {(drawer.row['Notes'] || drawer.row['Gift Message']) && (
                <Section title="Notes & Gift Message">
                  <div className="rounded border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm text-gray-800">
                    {[drawer.row['Notes'], drawer.row['Gift Message']]
                      .filter(Boolean)
                      .map((v) => String(v))
                      .join('\n\n')}
                  </div>
                </Section>
              )}
                  {(() => {
                    const exclude = new Set([
                      'Order Number','Order Status','Delivery Date','Dispatch Date','Packing Date','Rack','Area',
                      'Customer Name','Customer Email','Customer Phone',
                      'Billing Address','Billing City','Billing State','Billing Pincode',
                      'Shipping Address','Shipping City','Shipping State','Shipping Pincode',
                      'Offline Order Items','Notes','Gift Message'
                    ].map(normalizeHeaderName))
                    const entries = Object.entries(drawer.row)
                      .filter(([k,v]) => !exclude.has(normalizeHeaderName(k)) && v !== undefined && v !== null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null')
                    if (entries.length === 0) return null
                    return (
                      <Section title="All Fields">
                        <div className="overflow-hidden rounded border">
                          <table className="w-full text-xs">
                            <tbody>
                              {entries.map(([k,v], idx) => (
                                <tr key={k} className={idx % 2 ? 'bg-white' : 'bg-gray-50/40'}>
                                  <td className="px-3 py-1.5 font-medium text-gray-600 align-top">{k}</td>
                                  <td className="px-3 py-1.5">{String(v)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </Section>
                    )
                  })()}
              {drawer.row['Area'] && (
                <div className="mt-4">
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-sm">{drawer.row['Area']}</span>
                </div>
                  )}
                </>
              ) : (
                <div className="p-4 text-sm text-gray-600">Select an order to see details here.</div>
              )}
            </div>
          </div>
        </aside>
      </div>
      {/* end content */}
      {/* Settings modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
          <div className="w-full max-w-md rounded bg-white p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">Settings: T - X days</div>
              <button className="rounded border px-2 py-1" onClick={() => setSettingsOpen(false)}>Close</button>
            </div>
            <div className="space-y-3">
              {([
                { key: 'packers', label: 'Packers' },
                { key: 'collaterals', label: 'Collaterals' },
                { key: 'dispatchers', label: 'Dispatchers' },
                { key: 'holders', label: 'Holders' },
              ] as const).map(({ key, label }) => (
                <label key={key} className="flex items-center justify-between">
                  <span className="text-sm text-gray-700">{label}</span>
                  <input
                    type="number"
                    className="w-24 rounded border px-2 py-1"
                    value={txConfig[key]}
                    onChange={(e) => {
                      const next = { ...txConfig, [key]: Number(e.target.value || 0) }
                      setTxConfig(next)
                      try { localStorage.setItem('tx-config', JSON.stringify(next)) } catch {}
                    }}
                    min={0}
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Date Checker modal */}
      {dateCheckerOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
          <div className="w-full max-w-lg rounded bg-white p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-lg font-semibold">Date Checker</div>
              <button className="rounded border px-2 py-1" onClick={() => setDateCheckerOpen(false)}>Close</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Enter date from your CSV column:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded border px-3 py-2"
                    placeholder="e.g., 10-03-25, 12-07-25, 01-09-25"
                    value={dateCheckerInput}
                    onChange={(e) => setDateCheckerInput(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        testDateParsing(dateCheckerInput)
                      }
                    }}
                  />
                  <button 
                    className="rounded border px-3 py-2 bg-blue-500 text-white hover:bg-blue-600"
                    onClick={() => testDateParsing(dateCheckerInput)}
                  >
                    Test
                  </button>
                </div>
              </div>
              
              {dateCheckerResult && (
                <div className="rounded border p-3 bg-gray-50">
                  <div className="text-sm font-medium text-gray-700 mb-2">Result:</div>
                  {dateCheckerResult.error ? (
                    <div className="text-red-600 text-sm">
                      ❌ Error: {dateCheckerResult.error}
                    </div>
                  ) : (
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="font-medium">Parsed Date:</span> {dateCheckerResult.parsed?.toDateString()}
                      </div>
                      <div>
                        <span className="font-medium">Calendar Display:</span> {dateCheckerResult.formatted}
                      </div>
                      <div>
                        <span className="font-medium">Calendar Position:</span> {dateCheckerResult.parsed ? format(dateCheckerResult.parsed, 'MMMM yyyy') : 'N/A'}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs text-gray-500">
                <div className="font-medium mb-1">Expected format: DD-MM-YY</div>
                <div>Examples: 10-03-25 (March 10, 2025), 12-07-25 (July 12, 2025)</div>
                <div>Invalid: 10-13-25 (month 13 doesn't exist), 32-01-25 (day 32 doesn't exist)</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function KeyDate({ label, value, strong = false }: { label: string; value?: unknown; strong?: boolean }) {
  const shouldDebug = label === 'Delivery Date' && (String(value).includes('Sample_Puma_NB') || String(value).includes('45933'))
  if (shouldDebug) {
    console.log(`🎯 KeyDate DEBUG for ${label}:`)
    console.log(`  Raw value:`, value)
    console.log(`  Value type:`, typeof value)
  }
  
  const d = normalizeDate(value)
  
  if (shouldDebug) {
    console.log(`  Parsed date:`, d)
    console.log(`  Formatted:`, d ? format(d, 'dd-MM-yy') : 'null')
  }
  
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="w-36 text-gray-600">{label}</div>
      <div className={strong ? 'font-semibold' : ''}>{d ? format(d, 'dd-MM-yy') : '-'}</div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase()
  let cls = 'bg-slate-600'
  if (s.includes('pending')) cls = 'bg-amber-500'
  else if (s.includes('printed')) cls = 'bg-indigo-600'
  else if (s.includes('packed')) cls = 'bg-green-600'
  else if (s.includes('shipped')) cls = 'bg-blue-600'
  else if (s.includes('cancel')) cls = 'bg-red-600'
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-medium text-white ${cls}`}>{status || 'Unknown'}</span>
}

export default App
