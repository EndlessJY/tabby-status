const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  devtool: 'source-map',
  context: __dirname,
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'umd',
    devtoolModuleFilenameTemplate: 'webpack-tabby-status:///[resource-path]',
  },
  resolve: {
    modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
    extensions: ['.ts', '.js'],
  },
  externals: [
    /^rxjs/,
    /^@angular/,
    /^@ng-bootstrap/,
    /^tabby-/,
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
}
