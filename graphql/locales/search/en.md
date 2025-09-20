| Syntax                   | Description                                                                                                 | Examples                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `"` keyword `"`          | Finds the string within quotes, including spaces.<br>Case-insensitive.<br>(Escape quotes inside with `\"`)  | `"Hackers' Pub"`                                           |
| `from:` handle           | Finds content written by the specified user.                                                                | `from:hongminhee`<br>`from:hongminhee@hollo.social`        |
| `lang:` ISO 639-1        | Finds content written in the specified language.                                                            | `lang:en`                                                  |
| `#` tag                  | Finds content with the specified tag.<br>Case-insensitive.                                                  | `#HackersPub`                                              |
| condition `` condition   | Finds content that satisfies both conditions on either side of the space (logical AND).                     | `"Hackers' Pub" lang:en`                                   |
| condition `OR` condition | Finds content that satisfies at least one of the conditions on either side of the OR operator (logical OR). | `#HackersPub OR "Hackers' Pub" lang:en`                    |
| `(` condition `)`        | Combines the operators within the parentheses first.                                                        | `(#HackersPub OR "Hackers' Pub" OR "Hackers Pub") lang:en` |
