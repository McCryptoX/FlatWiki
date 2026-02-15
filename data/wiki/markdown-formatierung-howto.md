---
title: Markdown-Formatierung HowTo
tags:
  - howto
  - markdown
  - editor
createdAt: "2026-02-15T10:40:00.000Z"
updatedAt: "2026-02-15T17:05:00.000Z"
updatedBy: system
---

# Markdown-Formatierung in FlatWiki

Dieser Leitfaden zeigt die wichtigsten Formatierungen fuer Artikel.

## 1. Ueberschriften

```md
# Haupttitel (nur einmal pro Seite)
## Abschnitt
### Unterabschnitt
```

Hinweis: `##` und tiefer werden automatisch in die linke Inhaltsnavigation uebernommen.

## 2. Fettschrift und Kursiv

```md
**fett**
_kursiv_
```

## 3. Listen

Unsortierte Liste:

```md
- Punkt 1
- Punkt 2
- Punkt 3
```

Sortierte Liste:

```md
1. Schritt 1
2. Schritt 2
3. Schritt 3
```

## 4. Externe Links

```md
[OpenAI](https://openai.com)
```

## 5. Interne Wiki-Links

```md
[[Home]]
[[Markdown-Formatierung HowTo|Format-Hilfe]]
```

Hinweise:

- Der erste Teil verweist auf eine Wiki-Seite.
- Mit `|` kannst du einen eigenen Linktext setzen.
- Defekte interne Links werden im Admin-Bereich unter **Link-Check** angezeigt.

## 6. Bilder

Nach dem Upload im Editor wird dir der passende Markdown-Block automatisch eingefuegt.

Beispielstruktur:

```md
![Beschreibung](BILD-LINK-AUS-EDITOR)
```

Tipps:

- Jede Bilddatei wird automatisch sicher umbenannt.
- Verwende sinnvolle Alt-Texte fuer Barrierefreiheit.

## 7. Zitate

```md
> Das ist ein Zitat.
```

## 8. Code

Inline-Code:

```md
Nutze `docker compose up -d --build`.
```

Codeblock:

````md
```bash
docker compose up -d --build
```
````

## 9. Tabellen

```md
| Spalte A | Spalte B |
| --- | --- |
| Wert 1 | Wert 2 |
```

## 10. Trennlinie

```md
---
```

## 11. Gute Praxis

- Klare Abschnittstitel verwenden.
- Lange Seiten in mehrere Abschnitte aufteilen.
- Pro Seite nur ein `#` Haupttitel.
- Bei Befehlen immer Codeblock statt Fliesstext nutzen.
- Beim Erstellen kann die **Seitenadresse (URL-Pfad)** automatisch aus dem Titel erzeugt werden.
