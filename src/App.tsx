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
  return typeof value === 'number'
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

function normalizeDate(value: unknown): Date | null {
  if (!value) return null
  if (isExcelDate(value)) return startOfDay(excelDateToJSDate(value as number))
  if (typeof value === 'string') {
    const iso = Date.parse(value)
    if (!Number.isNaN(iso)) return startOfDay(new Date(iso))
    const parsed = parse(value, 'dd/MM/yyyy', new Date())
    if (!Number.isNaN(parsed.getTime())) return startOfDay(parsed)
  }
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
          if (!delivery) continue
          const resource: BosRow = { ...(r as any) }
          ;(resource as any)['Order Number'] = String(orderNumber)
          ;(resource as any)['Delivery Date'] = deliveryRawFallback as any
          eventsOut.push({
            title: String(orderNumber),
            start: startOfDay(delivery),
            end: endOfDay(delivery),
            resource,
          })
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
                onSelectEvent={(e: any) => setDrawer({ open: true, row: e.resource })}
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
                      const delivery = normalizeDate(drawer.row['Delivery Date'])
                      const dispatch = normalizeDate(drawer.row['Dispatch Date']) || (delivery ? addDays(delivery, -Math.max(1, Number((txConfig as any).dispatchers ?? 1))) : null)
                      const packing = normalizeDate(drawer.row['Packing Date']) || (delivery ? addDays(delivery, -Math.max(1, Number((txConfig as any).packers ?? 2))) : null)
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
  const d = normalizeDate(value)
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="w-36 text-gray-600">{label}</div>
      <div className={strong ? 'font-semibold' : ''}>{d ? format(d, 'dd MMM yyyy') : '-'}</div>
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
