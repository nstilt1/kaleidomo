cd ..

rm ./kaleidomo-source.zip

zip -r kaleidomo-source.zip ./kaleidomo-2 \
  -i "*.ts" \
  -i "*.tsx" \
  -i "*.js" \
  -i "*.jsx" \
  -i "*.json" \
  -i "*.toml" \
  -i "*.rs" \
  -i "*.wgsl" \
  -x "*/node_modules/*" \
  -x "*/target/*" \
  -x "*/pkg/*" \
  -x "*/dist/*"