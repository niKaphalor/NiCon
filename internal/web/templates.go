package web

import (
	"embed"
	"html/template"
)

//go:embed templates/*.html
var templateFS embed.FS

// staticFS's embedded paths already include the "static/" prefix (e.g.
// "static/style.css"), which matches the "/static/..." URLs directly -
// no fs.Sub needed.
//
//go:embed static
var staticFS embed.FS

func parsePage(name string) *template.Template {
	return template.Must(template.ParseFS(templateFS, "templates/base.html", "templates/"+name))
}

var (
	tmplIndex     = parsePage("index.html")
	tmplNewServer = parsePage("new_server.html")
	tmplPassword  = parsePage("password.html")
	tmplConsole   = parsePage("console.html")
	tmplNitrado   = parsePage("nitrado.html")
)
