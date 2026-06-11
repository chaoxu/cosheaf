# Self-hosted web fonts

- IBM Plex Sans (variable, latin + latin-ext, weight 400-700 plus 400 italic) -- SIL OFL 1.1, see LICENSE-ibm-plex.txt
- Inconsolata (variable, latin + latin-ext, weight 400-700) -- SIL OFL 1.1, see LICENSE-inconsolata.txt

Files were subset by Google Fonts (fonts.gstatic.com, css2 API). Self-hosted so
lab deployments never depend on an external font CDN. The matching @font-face
declarations live at the top of `public/cosheaf-web.css`.
