/** 极简线性图标（避免依赖宿主图标集的命名）。 */
const base = (size) => ({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })

export const IconPanel = ({ size = 16 }) => (
  <svg {...base(size)}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M6 2.75v10.5" />
  </svg>
)
export const IconPlus = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)
export const IconSearch = ({ size = 16 }) => (
  <svg {...base(size)}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.5 10.5 3 3" />
  </svg>
)
export const IconClose = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
)
export const IconRefresh = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </svg>
)
export const IconChat = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </svg>
)
export const IconTask = ({ size = 16 }) => (
  <svg {...base(size)}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="m5 8 2 2 4-4" />
  </svg>
)
export const IconFolder = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h3l1.5 1.5h5A1.5 1.5 0 0 1 14.25 6v5.5a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z" />
  </svg>
)
export const IconSend = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M14 2 7.5 8.5M14 2l-4.2 12-2.3-5.5L2 6.2z" />
  </svg>
)
export const IconLayout = ({ size = 16 }) => (
  <svg {...base(size)}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M10 2.75v10.5" />
  </svg>
)
export const IconTrash = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" />
  </svg>
)
export const IconLink = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />
  </svg>
)
export const IconCheck = ({ size = 16 }) => (
  <svg {...base(size)}>
    <path d="m3 8.5 3 3 7-7" />
  </svg>
)

const winIcon = {
  width: 10,
  height: 10,
  viewBox: '0 0 10 10',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1,
  'aria-hidden': true,
}

export const IconWinMin = () => (
  <svg {...winIcon}>
    <path d="M1 5h8" />
  </svg>
)
export const IconWinMax = () => (
  <svg {...winIcon}>
    <rect x="1.5" y="1.5" width="7" height="7" />
  </svg>
)
export const IconWinRestore = () => (
  <svg {...winIcon}>
    <rect x="1.5" y="3" width="5.5" height="5.5" />
    <path d="M3.5 3V1.5h5.5V7H7" />
  </svg>
)
export const IconWinClose = () => (
  <svg {...winIcon}>
    <path d="M2 2l6 6M8 2L2 8" />
  </svg>
)
