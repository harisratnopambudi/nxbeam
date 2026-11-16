#!/usr/bin/env python3
"""Section headers for the README (docs/headers/*.svg). Run: python3 tools/readme-headers.py"""
import os
BLUE = '#2B7BFF'
ICONS = {  # 24x24 stroke icons
    'screenshots': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M3 18l5.5-5.5 4 4L16 13l5 5"/>',
    'download': '<path d="M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    'features': '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    'android': '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    'setup': '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    'build': '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    'license': '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/>',
    'support': '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17M8 3.5v2.5M12 3.5v2.5"/>',
}
LABELS = {'screenshots': 'SCREENSHOTS', 'download': 'DOWNLOAD', 'features': 'FEATURES',
          'android': 'ANDROID APP', 'setup': 'SETUP', 'build': 'BUILD', 'license': 'LICENSE', 'support': 'SUPPORT'}
W, H = 1200, 96
for key, label in LABELS.items():
    tw = int(len(label) * 29.5)            # textLength keeps this width in every font
    tx = 148
    lx = tx + tw + 34
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-label="{label.title()}">
  <rect x="3" y="7" width="{W-6}" height="{H-14}" rx="18" fill="#121821" stroke="#2D3948" stroke-width="2"/>
  <rect x="3" y="15" width="10" height="{H-30}" rx="3" fill="{BLUE}"/>
  <g transform="translate(40,24) scale(2)" fill="none" stroke="#C9D0DA" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{ICONS[key]}</g>
  <rect x="112" y="27" width="2" height="42" rx="1" fill="#2D3948"/>
  <text x="{tx}" y="62" textLength="{tw}" lengthAdjust="spacing" font-family="Montserrat,'Segoe UI',Inter,Helvetica,Arial,sans-serif" font-size="38" font-weight="800" fill="#F2F4F7">{label}</text>
  <rect x="{lx}" y="46" width="{W-48-lx}" height="4" rx="2" fill="#2D3948"/>
  <rect x="{lx}" y="46" width="76" height="4" rx="2" fill="{BLUE}"/>
</svg>
'''
    open(os.path.join('docs/headers', key + '.svg'), 'w').write(svg)
print('ok')
