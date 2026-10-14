/* Kernel filters survive fork/exec; distinct fixed UIDs separate executor control from commands. */
#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__aarch64__)
#define HANDS_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define HANDS_ARCH AUDIT_ARCH_X86_64
#else
#error Unsupported hands kernel architecture
#endif

static void restrict_network(int granted) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, HANDS_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        /* Reject x32 and every compat ABI before interpreting native syscall arguments. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        /* io_uring can create/use sockets without the ordinary socket syscall boundary. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 1, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, granted ? SECCOMP_RET_ALLOW : (SECCOMP_RET_ERRNO | EPERM)),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0 ||
        setenv("SEPT_HANDS_NETWORK_GUARD", granted ? "granted" : "denied", 1) != 0) {
        _exit(126);
    }
}

__attribute__((constructor))
static void protect_hands_entry(void) {
    const char *network = getenv("SEPT_HANDS_NETWORK");
    int granted = network != NULL && strcmp(network, "1") == 0;
    if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 ||
        setenv("SEPT_HANDS_PROCESS_GUARD", "2", 1) != 0) {
        _exit(126);
    }
    umask(0007);
    restrict_network(granted);
}

#ifdef HANDS_GUARD_CHECK
/* Native image-owned helpers may read only data and their immutable runtime. Kernel checks
   apply to the resolved inode, including explicit file and ignore-file symlinks into proc/control. */
static void helper_read_rule(int ruleset, const char *path, int required, unsigned long long access) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (!required && errno == ENOENT) return;
        _exit(126);
    }
    struct landlock_path_beneath_attr rule = {
        .allowed_access = access,
        .parent_fd = fd,
    };
    if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0 || close(fd) != 0) _exit(126);
}
static int private_capture_name(const char *name) {
    return strncmp(name, "sept-hands-epoch-", 17) == 0 || strncmp(name, "sept-hands-mime-", 16) == 0;
}
static void helper_scratch_rules(int ruleset) {
    /* READ_DIR alone exposes no file bytes. Fixed exclusions below keep private capture
       names out of native enumeration; only nonprivate scratch inodes receive READ_FILE. */
    helper_read_rule(ruleset, "/tmp", 1, LANDLOCK_ACCESS_FS_READ_DIR);
    DIR *directory = opendir("/tmp");
    if (directory == NULL) _exit(126);
    struct dirent *entry;
    unsigned int count = 0;
    errno = 0;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0 || private_capture_name(entry->d_name)) continue;
        if (++count > 4096) _exit(126);
        int descriptor = openat(dirfd(directory), entry->d_name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
        struct stat identity;
        if (descriptor < 0 || fstat(descriptor, &identity) != 0) _exit(126);
        if (!S_ISDIR(identity.st_mode) && (!S_ISREG(identity.st_mode) || identity.st_nlink != 1)) {
            if (close(descriptor) != 0) _exit(126);
            continue;
        }
        unsigned long long access = LANDLOCK_ACCESS_FS_READ_FILE;
        if (S_ISDIR(identity.st_mode)) access |= LANDLOCK_ACCESS_FS_READ_DIR;
        struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = descriptor };
        if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0 || close(descriptor) != 0) _exit(126);
        errno = 0;
    }
    if (errno != 0 || closedir(directory) != 0) _exit(126);
}
static void execute_discovery_helper(char **argv, const char *name) {
    struct landlock_ruleset_attr rules = {
        .handled_access_fs = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR,
    };
    int ruleset = syscall(__NR_landlock_create_ruleset, &rules, sizeof(rules), 0);
    if (ruleset < 0) _exit(126);
    const char *required[] = { "/workspace", "/resources", "/usr", "/lib", "/etc", "/app" };
    unsigned long long access = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
    for (size_t index = 0; index < sizeof(required) / sizeof(required[0]); index++) helper_read_rule(ruleset, required[index], 1, access);
    helper_read_rule(ruleset, "/lib64", 0, access);
    helper_read_rule(ruleset, "/selected", 0, access);
    helper_scratch_rules(ruleset);
    if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0 || close(ruleset) != 0) _exit(126);
    char *arguments[128];
    unsigned int count = 0;
    arguments[count++] = argv[0];
    const int grep = strcmp(name, "rg") == 0;
    unsigned int original_count = 0;
    while (argv[original_count] != NULL) {
        if (++original_count >= 128) _exit(126);
    }
    const int scratch_root = original_count > 1 && strcmp(argv[original_count - 1], "/tmp") == 0;
    for (unsigned int index = 1; argv[index] != NULL; index++) {
        if (scratch_root && strcmp(argv[index], "--") == 0) {
            if (count > 122) _exit(126);
            /* Whole-scratch discovery hides reserved captures. Public workspace names retain native parity.
               Last rules win; native user globs cannot undo exclusions in the scratch root. */
            arguments[count++] = grep ? "--glob" : "--exclude";
            arguments[count++] = grep ? "!sept-hands-epoch-*" : "sept-hands-epoch-*";
            arguments[count++] = grep ? "--glob" : "--exclude";
            arguments[count++] = grep ? "!sept-hands-mime-*" : "sept-hands-mime-*";
        }
        if (count >= 127) _exit(126);
        arguments[count++] = argv[index];
    }
    arguments[count] = NULL;
    execv(grep ? "/app/hands-rg" : "/app/hands-fd", arguments);
    _exit(126);
}
/* Only kernel-sealed regular data is admitted for complete command/discovery traversal. */
static void sealed_inode(int fd, dev_t device, unsigned int depth, unsigned int *count);
static void sealed_directory(int fd, dev_t device, unsigned int depth, unsigned int *count) {
    DIR *directory = fdopendir(fd);
    if (directory == NULL) _exit(126);
    errno = 0;
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (++*count > 4096) _exit(126);
        int child = openat(dirfd(directory), entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (child < 0) _exit(126);
        sealed_inode(child, device, depth + 1, count);
        errno = 0;
    }
    if (errno != 0 || closedir(directory) != 0) _exit(126);
}
static void sealed_inode(int fd, dev_t device, unsigned int depth, unsigned int *count) {
    struct stat identity;
    unsigned long flags = 0;
    if (depth > 128 || fstat(fd, &identity) != 0 || identity.st_dev != device ||
        ioctl(fd, FS_IOC_GETFLAGS, &flags) != 0 || (flags & FS_IMMUTABLE_FL) == 0) _exit(126);
    if (S_ISDIR(identity.st_mode)) {
        sealed_directory(fd, device, depth, count);
    } else {
        if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 || close(fd) != 0) _exit(126);
    }
}
int main(int argc, char **argv) {
    const char *name = strrchr(argv[0], '/');
    name = name == NULL ? argv[0] : name + 1;
    if (strcmp(name, "rg") == 0 || strcmp(name, "fd") == 0) execute_discovery_helper(argv, name);
    if (argc != 3 || strcmp(argv[1], "--sealed") != 0 ||
        strncmp(argv[2], "/selected/", 10) != 0 || strchr(argv[2] + 10, '/') != NULL) return 126;
    int root = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat identity;
    unsigned int count = 0;
    if (root < 0 || fstat(root, &identity) != 0) return 126;
    sealed_inode(root, identity.st_dev, 0, &count);
    if (write(STDOUT_FILENO, "sealed\n", 7) != 7) return 126;
    return 0;
}
#endif
