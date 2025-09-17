import { useMemo, useState } from 'react'
import { Calendar as RBC, dateFnsLocalizer, View, Views } from 'react-big-calendar'
import { addDays, endOfDay, format, parse, startOfDay, startOfWeek as dfStartOfWeek, getDay as dfGetDay } from 'date-fns'
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

// Only the fields required to render events in the calendar.
const REQUIRED_FIELDS: Array<keyof BosRow> = ['Order Number', 'Delivery Date']

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

type ViewMode = 'day' | '3day' | 'week' | 'month'

function App() {
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [currentDate, setCurrentDate] = useState<Date>(startOfDay(new Date()))
  const [view, setView] = useState<ViewMode>('week')
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
      const orderNumberSynonyms = ['Order Number', 'Order No', 'Order#', 'Order Id', 'OrderID']
      const deliveryDateSynonyms = ['Delivery Date', 'Delivery Dt', 'DeliveryDate', 'Delivery']
      const hasOrderNumber = orderNumberSynonyms.some((h) => headerSet.has(normalizeHeaderName(h)))
      const hasDeliveryDate = deliveryDateSynonyms.some((h) => headerSet.has(normalizeHeaderName(h)))
      if (!hasOrderNumber || !hasDeliveryDate) {
        alert('This file must include at least Order Number and Delivery Date columns.')
        return
      }
      const mapped = json
        .map((r): OrderEvent | null => {
          const orderNumber = getValueFromRow(r as any, ['Order Number', 'Order No', 'Order#', 'Order Id', 'OrderID'])
          const deliveryRaw = getValueFromRow(r as any, ['Delivery Date', 'Delivery Dt', 'DeliveryDate', 'Delivery'])
          const delivery = normalizeDate(deliveryRaw)
          if (!orderNumber || !delivery) return null
          const resource: BosRow = { ...(r as any) }
          // Ensure canonical keys exist for downstream UI
          ;(resource as any)['Order Number'] = String(orderNumber)
          ;(resource as any)['Delivery Date'] = deliveryRaw as any
          return {
            title: String(orderNumber),
            start: startOfDay(delivery),
            end: endOfDay(delivery),
            resource,
          }
        })
        .filter(Boolean) as OrderEvent[]
      setEvents(mapped)
    }
    if (isCsv) reader.readAsText(file)
    else reader.readAsArrayBuffer(file)
  }

  const [dragOver, setDragOver] = useState(false)

  const eventStyleGetter = (event: OrderEvent) => {
    const status = (event.resource['Order Status'] || '').toString().toLowerCase()
    let bg = '#64748b'
    if (status.includes('pending')) bg = '#f59e0b'
    else if (status.includes('printed')) bg = '#6366f1'
    else if (status.includes('packed')) bg = '#22c55e'
    else if (status.includes('shipped')) bg = '#3b82f6'
    else if (status.includes('cancel')) bg = '#ef4444'
    return { style: { backgroundColor: bg, border: '0', color: 'white' } }
  }

  const handleNavigate = (action: 'prev' | 'next' | 'today') => {
    if (action === 'today') setCurrentDate(startOfDay(new Date()))
    else if (action === 'prev') setCurrentDate(addDays(currentDate, view === '3day' ? -3 : -1))
    else if (action === 'next') setCurrentDate(addDays(currentDate, view === '3day' ? 3 : 1))
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
                { k: '3day', label: '3-Day' },
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
      <div
        className={`relative flex-1 ${events.length === 0 ? 'grid place-items-center' : ''}`}
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
              popup
              length={view === '3day' ? 3 : undefined}
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
      {drawer.open && drawer.row && (
        <aside className="fixed inset-y-0 right-0 w-full max-w-xl transform border-l bg-white shadow-xl transition md:translate-x-0">
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="text-xl font-bold">{drawer.row['Order Number']}</div>
              <button className="rounded border px-3 py-1" onClick={() => setDrawer({ open: false, row: null })}>
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-4">
                <StatusPill status={(drawer.row['Order Status'] || '') as string} />
              </div>
              <Section title="Key Dates">
                <KeyDate label="Delivery Date" value={drawer.row['Delivery Date']} strong />
                <KeyDate label="Dispatch Date" value={drawer.row['Dispatch Date']} />
                <KeyDate label="Packing Date" value={drawer.row['Packing Date']} />
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
                <pre className="whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm">{drawer.row['Offline Order Items']}</pre>
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
              {drawer.row['Area'] && (
                <div className="mt-4">
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-sm">{drawer.row['Area']}</span>
                </div>
              )}
            </div>
          </div>
        </aside>
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
