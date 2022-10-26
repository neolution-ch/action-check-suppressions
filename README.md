# action-check-suppressions

This action check for code analyzer suppressions and add a comment to the pull request

# Usage

See [action.yml](action.yml)

```yaml
steps:
- uses: neolution-ch/action-check-suppressions@v1
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    continueOnError: false # default
```

# License

[MIT](LICENSE.md)
