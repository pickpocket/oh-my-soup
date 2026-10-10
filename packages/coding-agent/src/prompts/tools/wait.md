Wait only when blocked with nothing else to do.
Returns on the first owned job result, peer message, or steering interrupt; an owned-work safety cap returns the current state.
No owned work? A short message window grows on repeated waits. No running peer or owned work? Errors immediately.
Results and messages auto-deliver. NEVER poll while work remains. Circular agent waits return an error naming the cycle; do independent work, send the needed message, or yield before waiting again.
