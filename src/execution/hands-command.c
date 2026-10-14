/* The Engine selects this immutable entry and fixed command UID. No inherited control descriptors survive. */
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <unistd.h>
#include <string.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <sys/prctl.h>
#include <errno.h>
static void allow_read(int ruleset, const char *path, int required) {
    int descriptor = open(path, O_PATH | O_CLOEXEC);
    if (descriptor < 0) {
        if (!required && errno == ENOENT) return;
        _exit(126);
    }
    struct landlock_path_beneath_attr rule = {
        .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR,
        .parent_fd = descriptor,
    };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0 || close(descriptor) != 0) _exit(126);
}
static void private_process_view(void) {
    /* The real command may traverse granted data/runtime, never the resident's imports, proc or HOME/control view. */
    struct landlock_ruleset_attr rules = { .handled_access_fs = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR };
    int ruleset = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
    if (ruleset < 0) _exit(126);
    const char *required[] = { "/workspace", "/resources", "/tmp", "/usr", "/lib", "/etc", "/dev" };
    for (unsigned int index = 0; index < sizeof(required) / sizeof(required[0]); index++) allow_read(ruleset, required[index], 1);
    allow_read(ruleset, "/lib64", 0);
    allow_read(ruleset, "/selected", 0);
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0 || close(ruleset) != 0) _exit(126);
}
int main(int argc, char **argv) {
    if (getuid() != 10003 || getgid() != 10002 || argc != 3 ||
        syscall(SYS_close_range, 3U, ~0U, 0U) != 0) return 126;
    private_process_view();
    if (strcmp(argv[1], "bash") == 0) {
        execl("/bin/bash", "bash", "--noprofile", "--norc", "-c", argv[2], (char *)NULL);
    } else if (strcmp(argv[1], "custom") == 0) {
        execl("/usr/local/bin/node", "node", "--disable-sigusr1", "--input-type=module", "--eval", argv[2], (char *)NULL);
    }
    return 126;
}
