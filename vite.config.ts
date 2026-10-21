import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// GitHub Pages serves this repo at /scorm-mini-editor-2/
export default defineConfig({
  base: '/scorm-mini-editor-2/',
  plugins: [react(), tailwindcss()],
})
