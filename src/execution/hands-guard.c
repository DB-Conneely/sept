/* Linux hands entry protects its memory/control descriptors from same-UID command children. */
#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

__attribute__((constructor))
static void protect_hands_entry(void) {
    if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        setenv("SEPT_HANDS_PROCESS_GUARD", "1", 1) != 0) {
        _exit(126);
    }
}
